import { createHash } from "node:crypto";
import { PoolConnection } from "mysql2/promise";
import { databaseIdentity, scopedLock, sql } from "../database/managed-mysql";
import { prepareTenant, PrepareOptions } from "./prepare";
import { inspectWppSchema } from "./inspect-wpp-schema";
import { manifestHash } from "./prepare-contract";
import { DataAccess, rowCursor, rowKey, validateRow } from "./data-access";
import { compareRow, dataContractHash, DataRow, entities, mapRow, TenantDataError } from "./data-contract";
import { checkDataJournal, DataJournal, emptyCheckpoint, journalSql } from "./data-journal";
import { resolveLegacyTimezone } from "./data-timezone";
import { checkTargetUniqueKeys, checkUniquePage, writeRows } from "./data-write";

export interface DataMigrationOptions extends PrepareOptions {
	phase: "copy" | "verify"; runId: string; legacyTimezone: string;
	expectedSourceHostname: string; expectedSourceDatabase: string;
	batchSize: number; maxBatches: number; maxDurationSeconds: number;
}

export async function migrateTenantData(sourceConnection: PoolConnection, targetConnection: PoolConnection, options: DataMigrationOptions) {
	const timeout = options.queryTimeoutMs ?? 30000;
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.runId)) throw new TenantDataError("TENANT_RUN_ID_INVALID");
	if (options.apply && (!options.writersQuiesced || !options.expectedSourceHostname || !options.expectedSourceDatabase)) throw new TenantDataError("TENANT_DATA_CONFIRMATION_REQUIRED");
	if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 500 || !Number.isInteger(options.maxBatches) || options.maxBatches < 1 || options.maxBatches > 10000
		|| !Number.isInteger(options.maxDurationSeconds) || options.maxDurationSeconds < 1 || options.maxDurationSeconds > 3600) throw new TenantDataError("TENANT_DATA_LIMIT_INVALID");
	let stage = "data-preflight", entityLabel = "";
	const progress = (next: string, entity = "") => { stage = next; entityLabel = entity; options.progress(stage, entityLabel); };
	const source = new DataAccess(sourceConnection, true, options.tenant, timeout, name => options.progress(stage, entityLabel, name));
	const target = new DataAccess(targetConnection, false, options.tenant, timeout, name => options.progress(stage, entityLabel, name));
	// The source connection is dedicated to SELECTs, enforced by the server too (central MySQL >=5.6).
	await source.query("autocommit", "SET SESSION autocommit=1");
	await source.query("read-only", "SET SESSION TRANSACTION READ ONLY");
	const sourceIdentity = await databaseIdentity(sourceConnection, timeout), targetIdentity = await databaseIdentity(targetConnection, timeout);
	if (sourceIdentity.hostname === targetIdentity.hostname && sourceIdentity.port === targetIdentity.port && sourceIdentity.database_name.toLowerCase() === targetIdentity.database_name.toLowerCase()) throw new TenantDataError("TENANT_SOURCE_EQUALS_TARGET");
	if ((options.expectedSourceHostname && sourceIdentity.hostname !== options.expectedSourceHostname) || (options.expectedSourceDatabase && sourceIdentity.database_name !== options.expectedSourceDatabase)) throw new TenantDataError("TENANT_SOURCE_IDENTITY_MISMATCH");
	let locked = false;
	const lock = scopedLock(targetIdentity.database_name, "tenant-prepare"); // Same lock as prepare; MySQL 5.5 supports one named lock/session.
	try {
		await target.query("autocommit", "SET SESSION autocommit=1");
		const acquired = await target.query<DataRow[]>("lock", "SELECT GET_LOCK(?,0) AS acquired", [lock]);
		if (Number(acquired[0]?.["acquired"]) !== 1) throw new TenantDataError("TENANT_DATA_BUSY");
		locked = true;
		const prepared = await prepareTenant(targetConnection, { ...options, apply: false });
		if (prepared.schemaChangesRequired) throw new TenantDataError("TENANT_DATA_NOT_PREPARED");
		const fingerprint = createHash("sha256").update(JSON.stringify([targetIdentity.hostname, targetIdentity.port, targetIdentity.database_name])).digest("hex");
		const binding = await target.query<DataRow[]>("prepared-state", "SELECT tenant,target_fingerprint,manifest_hash,state FROM wpp_tenant_prepare WHERE step_id='binding'");
		if (binding.length !== 1 || binding[0]?.["state"] !== "PREPARED" || binding[0]?.["tenant"] !== options.tenant || binding[0]?.["manifest_hash"] !== manifestHash || binding[0]?.["target_fingerprint"] !== fingerprint) throw new TenantDataError("TENANT_DATA_NOT_PREPARED");
		const schema = await inspectWppSchema(targetConnection, timeout);
		const journalExists = checkDataJournal(schema);
		for (const entity of entities) {
			progress("source-schema", entity);
			await source.query("shape", `SELECT ${source.select(entity)} FROM ${source.from(entity)} LIMIT 0`);
		}
		progress("data-timezone");
		const timezone = await resolveLegacyTimezone(source, target, options.legacyTimezone).catch(error => {
			if (error instanceof TenantDataError) throw new TenantDataError(error.diagnosticCode, { ...error.context, sourceIdentity, targetIdentity });
			throw error;
		});
		const packets = await Promise.all([source.query<DataRow[]>("packet", "SELECT @@max_allowed_packet AS bytes"), target.query<DataRow[]>("packet", "SELECT @@max_allowed_packet AS bytes")]);
		const budget = Math.min(524288, ...packets.map(rows => Math.floor(Number(rows[0]?.["bytes"]) / 2)));
		if (!Number.isSafeInteger(budget) || budget < 16384) throw new TenantDataError("TENANT_PACKET_BUDGET_INVALID");
		source.maxReadBytes = target.maxReadBytes = budget * 2;
		const bindingHash = createHash("sha256").update(JSON.stringify({ sourceIdentity, targetIdentity, tenant: options.tenant, timezone: timezone.timezone, dataContractHash })).digest("hex");
		const journal = new DataJournal(target, options.runId, bindingHash);
		if (journalExists) await journal.checkBinding();
		// Association rows without a parent cannot safely be attributed to a tenant.
		const orphans = await target.query<DataRow[]>("orphan-associations", "SELECT s.contact_id,s.sector_id FROM wpp_contact_sectors s LEFT JOIN wpp_contacts p ON p.id=s.contact_id WHERE p.id IS NULL LIMIT 1");
		if (orphans.length) throw new TenantDataError("TENANT_TARGET_ORPHAN_ASSOCIATION", { key: rowKey("contacts_sectors", orphans[0]!) });
		if (options.apply && !journalExists) await sql(targetConnection, journalSql, [], options.ddlTimeoutMs);
		const report = { phase: options.phase, runId: options.runId, entities, sourceIdentity, targetIdentity, timezone, packetBudgetBytes: budget, dataContractHash, readyForCutover: false,
			mode: options.apply ? "apply" : "dry-run", queryTimeoutMs: timeout, resumeRequiresSameMaintenanceWindow: true };
		const checkpoints: Record<string, unknown> = {};
		let batches = 0; const started = Date.now();
		for (const direction of options.phase === "verify" ? ["forward", "reverse"] : ["forward"]) {
			for (const entity of entities) {
				const label = `${direction}:${entity}`;
				// A preview always starts at the beginning; it never hides rows behind a saved checkpoint.
				let point = options.apply ? await journal.load(options.phase, entity, direction) : emptyCheckpoint();
				checkpoints[label] = point;
				while (!point.done) {
					if (batches >= options.maxBatches || Date.now() - started >= options.maxDurationSeconds * 1000) return { ...report, status: "INCOMPLETE", complete: false, batches, checkpoints };
					progress(`data-${direction}-page`, entity);
					const fetched = await (direction === "forward" ? source : target).page(entity, point.cursor, options.batchSize);
					const page = fetched.rows;
					checkUniquePage(entity, page);
					if (direction === "forward") await source.validateReferences(entity, page);
					let transaction = false;
					try {
						if (options.apply) { await target.query("begin", "START TRANSACTION"); transaction = true; }
						const other = direction === "forward" ? await target.matching(entity, page, options.apply && options.phase === "copy") : await source.matching(entity, page);
						const byKey = new Map(other.map(row => [rowKey(entity, row), row]));
						const inserts: DataRow[] = [], enrichments: { row: DataRow; columns: string[] }[] = [];
						const conflicts: { entity: string; key: string; columns: string[]; reason: string }[] = [];
						for (const row of page) {
							const key = rowKey(entity, row), found = byKey.get(key);
							const original = direction === "forward" ? row : found, actual = direction === "forward" ? found : row;
							if (!original) { conflicts.push({ entity, key, columns: [], reason: "TARGET_ONLY_ROW" }); continue; }
							const expected = mapRow(entity, original, timezone.timezone);
							validateRow(entity, expected, schema.columns as DataRow[], budget);
							if (!actual) {
								if (options.phase === "copy") inserts.push(expected);
								else conflicts.push({ entity, key, columns: [], reason: "MISSING_TARGET_ROW" });
								continue;
							}
							const difference = compareRow(entity, expected, actual, options.phase === "copy");
							if (difference.conflicts.length) conflicts.push({ entity, key, columns: difference.conflicts, reason: "CONTENT_CONFLICT" });
							else if (difference.enrich.length) enrichments.push({ row: expected, columns: difference.enrich });
						}
						if (conflicts.length) {
							if (transaction) { await target.query("rollback", "ROLLBACK"); transaction = false; }
							return { ...report, status: "CONFLICT", complete: false, checkpoints, conflicts: conflicts.slice(0, 20), conflictsInPage: conflicts.length };
						}
						if (options.phase === "copy") await checkTargetUniqueKeys(target, entity, inserts, budget);
						if (options.apply && options.phase === "copy") {
							progress("data-write", entity);
							await writeRows(target, entity, inserts, enrichments, budget);
							// Read back before committing the same transaction and checkpoint.
							const saved = new Map((await target.matching(entity, page)).map(row => [rowKey(entity, row), row]));
							for (const original of page) {
								const key = rowKey(entity, original), actual = saved.get(key);
								if (!actual || compareRow(entity, mapRow(entity, original, timezone.timezone), actual, false).conflicts.length) throw new TenantDataError("TENANT_COPY_READBACK_FAILED", { entity, key });
							}
						}
						const next = { cursor: page.length ? rowCursor(entity, page[page.length - 1]!) : point.cursor, scanned: point.scanned + page.length, inserted: point.inserted + inserts.length, enriched: point.enriched + enrichments.length, done: fetched.exhausted };
						if (options.apply) {
							await journal.save(options.phase, entity, direction, next);
							progress("data-commit", entity);
							await target.query("commit", "COMMIT"); transaction = false;
						}
						point = next; checkpoints[label] = point; batches++;
						progress("data-page-complete", entity);
					} catch (error) {
						if (transaction) { try { await sql(targetConnection, "ROLLBACK", [], timeout); } catch { /* preserve original error and diagnostic, no replay */ } }
						throw error;
					}
				}
			}
		}
		return { ...report, status: options.apply ? options.phase === "copy" ? "COPIED" : "VERIFIED" : "PLANNED", complete: true, batches, checkpoints };
	} finally {
		if (locked) { try { await sql(targetConnection, "SELECT RELEASE_LOCK(?)", [lock], timeout); } catch { /* session teardown releases lock, never retry writes */ } }
	}
}
