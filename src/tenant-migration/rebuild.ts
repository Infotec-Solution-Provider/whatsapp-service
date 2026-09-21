import { createHash } from "node:crypto";
import { PoolConnection } from "mysql2/promise";
import { databaseIdentity, scopedLock, sql } from "../database/managed-mysql";
import { DataAccess, rowCursor, validateRow } from "./data-access";
import { dataContractHash, DataRow, entities, mapRow, tables, TenantDataError } from "./data-contract";
import { DataMigrationOptions } from "./data-migrate";
import { checkUniquePage, writeRows } from "./data-write";
import { resolveLegacyTimezone } from "./data-timezone";
import { prepareTenant } from "./prepare";
import { manifestHash, quote } from "./prepare-contract";
import { inspectWppSchema } from "./inspect-wpp-schema";
import { addDigest, emptyDigest, verifyDigest } from "./rebuild-checksum";
import { checkRebuildJournal, RebuildJournal, rebuildJournalSql, RebuildState } from "./rebuild-journal";
import { checkRebuildTables, checkSyncState, rebuildNames, rebuildProjection, tableMarkers, targetOverrides } from "./rebuild-tables";

export type RebuildOptions = Omit<DataMigrationOptions, "phase"> & { phase: "rebuild" };

/** Load private persistent shadows, check transport integrity, rename together, then remove old tenant tables. */
export async function rebuildTenant(sourceConnection: PoolConnection, targetConnection: PoolConnection, options: RebuildOptions) {
	const timeout = options.queryTimeoutMs ?? 30000;
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.runId)) throw new TenantDataError("TENANT_RUN_ID_INVALID");
	if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 500 || !Number.isInteger(options.maxBatches) || options.maxBatches < 1 || options.maxBatches > 10000
		|| !Number.isInteger(options.maxDurationSeconds) || options.maxDurationSeconds < 1 || options.maxDurationSeconds > 3600) throw new TenantDataError("TENANT_DATA_LIMIT_INVALID");
	if (options.apply && (!options.writersQuiesced || !options.expectedSourceHostname || !options.expectedSourceDatabase)) throw new TenantDataError("TENANT_DATA_CONFIRMATION_REQUIRED");
	let stage = "rebuild-preflight", currentEntity = "";
	const progress = (next: string, entity = "") => { stage = next; currentEntity = entity; options.progress(stage, entity); };
	const queries = (name: string) => options.progress(stage, currentEntity, name);
	const source = new DataAccess(sourceConnection, true, options.tenant, timeout, queries);
	const target = new DataAccess(targetConnection, false, options.tenant, timeout, queries);
	await source.query("autocommit", "SET SESSION autocommit=1");
	await source.query("read-only", "SET SESSION TRANSACTION READ ONLY");
	const sourceIdentity = await databaseIdentity(sourceConnection, timeout), targetIdentity = await databaseIdentity(targetConnection, timeout);
	if (sourceIdentity.hostname === targetIdentity.hostname && sourceIdentity.port === targetIdentity.port && sourceIdentity.database_name.toLowerCase() === targetIdentity.database_name.toLowerCase()) throw new TenantDataError("TENANT_SOURCE_EQUALS_TARGET");
	if ((options.expectedSourceHostname && sourceIdentity.hostname !== options.expectedSourceHostname) || (options.expectedSourceDatabase && sourceIdentity.database_name !== options.expectedSourceDatabase)) throw new TenantDataError("TENANT_SOURCE_IDENTITY_MISMATCH");
	const lock = scopedLock(targetIdentity.database_name, "tenant-prepare");
	let locked = false, transaction = false;
	try {
		await target.query("autocommit", "SET SESSION autocommit=1");
		const rows = await target.query<DataRow[]>("lock", "SELECT GET_LOCK(?,0) AS acquired", [lock]);
		if (Number(rows[0]?.["acquired"]) !== 1) throw new TenantDataError("TENANT_DATA_BUSY");
		locked = true;
		const prepared = await prepareTenant(targetConnection, { ...options, apply: false });
		if (prepared.schemaChangesRequired) throw new TenantDataError("TENANT_DATA_NOT_PREPARED");
		const fingerprint = createHash("sha256").update(JSON.stringify([targetIdentity.hostname, targetIdentity.port, targetIdentity.database_name])).digest("hex");
		const receipts = await target.query<DataRow[]>("prepared-state", "SELECT tenant,target_fingerprint,manifest_hash,state FROM wpp_tenant_prepare WHERE step_id='binding'");
		if (receipts.length !== 1 || receipts[0]?.["state"] !== "PREPARED" || receipts[0]?.["tenant"] !== options.tenant || receipts[0]?.["manifest_hash"] !== manifestHash || receipts[0]?.["target_fingerprint"] !== fingerprint) throw new TenantDataError("TENANT_DATA_NOT_PREPARED");
		const schema = await inspectWppSchema(targetConnection, timeout);
		checkRebuildTables(schema);
		const syncStateExists = checkSyncState(schema);
		const journalExists = checkRebuildJournal(schema);
		const timezone = await resolveLegacyTimezone(source, target, options.legacyTimezone);
		const binding = createHash("sha256").update(JSON.stringify({ version: "shadow-rebuild-v1", sourceIdentity, targetIdentity, tenant: options.tenant, timezone: timezone.timezone, dataContractHash })).digest("hex");
		const token = createHash("sha256").update(`${options.runId}:${binding}`).digest("hex").slice(0, 20);
		const names = rebuildNames(token), entries = Object.values(names), marker = `inpulse-rebuild:${token}`;
		const allNames = entries.flatMap(n => [n.live, n.shadow, n.old]);
		const shadow = new DataAccess(targetConnection, false, options.tenant, timeout, queries, targetOverrides(names));
		const journal = new RebuildJournal(target, options.runId, binding);
		let state = journalExists ? await journal.load() : null;
		const report = () => ({ phase: "rebuild", runId: options.runId, mode: options.apply ? "apply" : "dry-run", sourceIdentity, targetIdentity,
			timezone, tables: entries, referencePolicy: "preserve-source-values", readyForCutover: false, resumeRequiresSameMaintenanceWindow: true,
			state: state?.phase ?? "NOT_STARTED", checkpoints: state?.points, lastMessages: state?.lastMessages ?? 0 });
		if (state?.phase === "COMPLETE") return { ...report(), status: "REBUILT", complete: true };
		let markers = await tableMarkers(target, allNames);
		if (!state && entries.some(n => markers[n.shadow] !== undefined || markers[n.old] !== undefined)) throw new TenantDataError("TENANT_REBUILD_TABLE_COLLISION");
		if (state) {
			for (const entity of entities) {
				const point = state.points[entity];
				if (!point || !Number.isSafeInteger(point.count) || point.count < 0 || !Array.isArray(point.cursor) || point.cursor.length !== 2
					|| point.cursor.some(n => !Number.isSafeInteger(n) || n < -2147483649) || typeof point.done !== "boolean"
					|| ![point.high, point.low].every(n => /^\d{1,20}$/.test(n) && BigInt(n) <= 18446744073709551615n)) throw new TenantDataError("TENANT_REBUILD_JOURNAL_INVALID");
			}
		}
		if (!options.apply) {
			const counts: Record<string, number> = {};
			for (const entity of entities) {
				const scope = source.scope(entity);
				const count = await source.query<DataRow[]>("rebuild-source-count", `SELECT COUNT(*) AS n FROM ${source.from(entity)}${scope.join} WHERE ${scope.where}`, scope.values);
				counts[entity] = Number(count[0]?.["n"]);
			}
			return { ...report(), status: "PLANNED", complete: false, previewOnly: true, sourceRows: counts,
				actions: ["create-private-shadows", "bulk-copy-source", "verify-counts-and-checksums", "rename-six-tables-together", "drop-old-tenant-tables"], payloadsValidated: false };
		}
		if (!journalExists) await sql(targetConnection, rebuildJournalSql, [], options.ddlTimeoutMs);
		if (!state) {
			state = { version: 1, phase: "CREATING", markers: Object.fromEntries(entries.map(n => [n.live, markers[n.live]!])),
				points: Object.fromEntries(entities.map(entity => [entity, { ...emptyDigest(), cursor: [-2147483649, -2147483649], done: false }])) as RebuildState["points"], lastMessages: 0 };
			await journal.save(state);
		}
		const checkOriginal = () => {
			if (entries.some(n => markers[n.live] === undefined || markers[n.live] !== state!.markers[n.live] || markers[n.old] !== undefined)) throw new TenantDataError("TENANT_REBUILD_TABLE_STATE_INVALID");
		};
		if (["CREATING", "COPYING", "VERIFYING"].includes(state.phase)) checkOriginal();
		if (state.phase === "CREATING") {
			progress("rebuild-create");
			for (const n of entries) {
				if (markers[n.shadow] === undefined) await sql(targetConnection, `CREATE TABLE ${quote(n.shadow)} LIKE ${quote(n.live)}`, [], options.ddlTimeoutMs);
				else if (markers[n.shadow] !== marker && markers[n.shadow] !== state.markers[n.live]) throw new TenantDataError("TENANT_REBUILD_TABLE_STATE_INVALID");
				await sql(targetConnection, `ALTER TABLE ${quote(n.shadow)} COMMENT='${marker}'`, [], options.ddlTimeoutMs);
			}
			state.phase = "COPYING"; await journal.save(state);
		}
		const packets = await Promise.all([source.query<DataRow[]>("packet", "SELECT @@max_allowed_packet AS bytes"), target.query<DataRow[]>("packet", "SELECT @@max_allowed_packet AS bytes")]);
		const budget = Math.min(524288, ...packets.map(r => Math.floor(Number(r[0]?.["bytes"]) / 2)));
		if (!Number.isSafeInteger(budget) || budget < 16384) throw new TenantDataError("TENANT_PACKET_BUDGET_INVALID");
		source.maxReadBytes = budget * 2;
		const started = Date.now(); let batches = 0;
		if (state.phase === "COPYING") {
			markers = await tableMarkers(target, allNames);
			if (entries.some(n => markers[n.shadow] !== marker)) throw new TenantDataError("TENANT_REBUILD_TABLE_STATE_INVALID");
			for (const entity of entities) {
				let point = state.points[entity];
				while (!point.done) {
					if (batches >= options.maxBatches || Date.now() - started >= options.maxDurationSeconds * 1000) return { ...report(), status: "INCOMPLETE", complete: false, batches };
					progress("rebuild-copy", entity);
					const page = await source.page(entity, point.cursor, options.batchSize);
					checkUniquePage(entity, page.rows);
					const mapped = page.rows.map(row => mapRow(entity, row, timezone.timezone));
					for (const row of mapped) validateRow(entity, row, schema.columns as DataRow[], budget);
					const next = { ...addDigest(point, entity, mapped), cursor: page.rows.length ? rowCursor(entity, page.rows[page.rows.length - 1]!) : point.cursor, done: page.exhausted };
					await target.query("begin", "START TRANSACTION"); transaction = true;
					await writeRows(shadow, entity, mapped, [], budget);
					state.points[entity] = next; await journal.save(state);
					progress("rebuild-commit", entity);
					await target.query("commit", "COMMIT"); transaction = false;
					point = next; batches++;
					progress("rebuild-page-complete", entity);
				}
			}
			state.phase = "VERIFYING"; await journal.save(state);
		}
		if (state.phase === "VERIFYING") {
			markers = await tableMarkers(target, allNames); checkOriginal();
			if (entries.some(n => markers[n.shadow] !== marker)) throw new TenantDataError("TENANT_REBUILD_TABLE_STATE_INVALID");
			for (const entity of entities) { progress("rebuild-verify", entity); await verifyDigest(target, entity, names[tables[entity]]!.shadow, state.points[entity]); }
			progress("rebuild-projection");
			await target.query("begin", "START TRANSACTION"); transaction = true;
			state.lastMessages = await rebuildProjection(target, names);
			state.phase = "SWAPPING"; await journal.save(state);
			await target.query("commit", "COMMIT"); transaction = false;
		}
		if (state.phase === "SWAPPING") {
			markers = await tableMarkers(target, allNames);
			const before = entries.every(n => markers[n.shadow] === marker && markers[n.old] === undefined && markers[n.live] === state!.markers[n.live]);
			const after = entries.every(n => markers[n.shadow] === undefined && markers[n.live] === marker && markers[n.old] === state!.markers[n.live]);
			if (!before && !after) throw new TenantDataError("TENANT_REBUILD_TABLE_STATE_INVALID");
			if (before) {
				progress("rebuild-swap");
				await sql(targetConnection, `RENAME TABLE ${entries.flatMap(n => [`${quote(n.live)} TO ${quote(n.old)}`, `${quote(n.shadow)} TO ${quote(n.live)}`]).join(",")}`, [], options.ddlTimeoutMs);
			}
			state.phase = "CLEANUP"; await journal.save(state);
		}
		if (state.phase === "CLEANUP") {
			markers = await tableMarkers(target, allNames);
			if (entries.some(n => markers[n.live] !== marker || markers[n.shadow] !== undefined || (markers[n.old] !== undefined && markers[n.old] !== state!.markers[n.live]))) throw new TenantDataError("TENANT_REBUILD_TABLE_STATE_INVALID");
			// Check the live generation/counts before deleting any backup; missing backups permit cleanup resume.
			for (const n of entries) {
				const rows = await target.query<DataRow[]>("rebuild-live-count", `SELECT COUNT(*) AS n FROM ${quote(n.live)}`);
				const entity = entities.find(e => tables[e] === n.live);
				if (Number(rows[0]?.["n"]) !== (entity ? state.points[entity].count : state.lastMessages)) throw new TenantDataError("TENANT_REBUILD_CHECKSUM_MISMATCH", { table: n.live });
			}
			if (syncStateExists) await target.query("rebuild-sync-cursor", "INSERT INTO wpp_sync_state (entity,last_synced_id) VALUES ('messages',?) ON DUPLICATE KEY UPDATE last_synced_id=VALUES(last_synced_id)", [Math.max(0, state.points.messages.cursor[0])]);
			for (const n of entries) {
				if (markers[n.old] === undefined) continue;
				progress("rebuild-drop-old", n.live);
				await sql(targetConnection, `DROP TABLE ${quote(n.old)}`, [], options.ddlTimeoutMs);
			}
			state.phase = "COMPLETE"; await journal.save(state);
		}
		return { ...report(), status: "REBUILT", complete: true, batches };
	} catch (error) {
		if (transaction) { try { await sql(targetConnection, "ROLLBACK", [], timeout); } catch { /* preserve original failure, no replay */ } }
		throw error;
	} finally {
		if (locked) { try { await sql(targetConnection, "SELECT RELEASE_LOCK(?)", [lock], timeout); } catch { /* connection teardown releases lock */ } }
	}
}
