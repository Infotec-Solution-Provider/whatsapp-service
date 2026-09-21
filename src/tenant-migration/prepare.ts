import { createHash } from "node:crypto";
import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { databaseIdentity, scopedLock, sql } from "../database/managed-mysql";
import { probeTenantText } from "./inspect";
import { inspectWppSchema } from "./inspect-wpp-schema";
import { legacyContract } from "./legacy-contract";
import { buildPreparePlan, PrepareBlocker } from "./prepare-plan";
import { journalDdl, journalTable, manifestHash, prepareVersion, quote, storageContract } from "./prepare-contract";

export class TenantPrepareError extends Error {
	constructor(readonly diagnosticCode: string, readonly blockers: PrepareBlocker[] = []) { super(diagnosticCode); }
}

export interface PrepareOptions {
	tenant: string;
	profile: string;
	expectedHostname: string;
	expectedDatabase: string;
	apply: boolean;
	writersQuiesced: boolean;
	ddlTimeoutMs: number;
	queryTimeoutMs?: number;
	progress: (stage: string, step?: string, query?: string) => void;
}

/** DDL commits independently. Resume by inspecting the real schema, never by blindly replaying SQL. */
export async function prepareTenant(connection: PoolConnection, options: PrepareOptions) {
	const queryTimeoutMs = options.queryTimeoutMs ?? 30000;
	if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1000 || queryTimeoutMs > 120000)
		throw new TenantPrepareError("TENANT_QUERY_TIMEOUT_INVALID");
	let stage = "prepare-identity", currentStep: string | undefined;
	const progress = (nextStage: string, step?: string) => {
		stage = nextStage; currentStep = step; options.progress(stage, currentStep);
	};
	const onQuery = (name: string) => options.progress(stage, currentStep, name);
	const query = <T>(name: string, statement: string, values: unknown[] = []) => {
		onQuery(name); return sql<T>(connection, statement, values, queryTimeoutMs);
	};
	const inspect = () => inspectWppSchema(connection, queryTimeoutMs, onQuery);
	if (options.profile !== "percent-encoded-v1") throw new TenantPrepareError("TENANT_PREPARE_PROFILE_UNSUPPORTED");
	if (!options.expectedHostname || !options.expectedDatabase) throw new TenantPrepareError("TENANT_PREPARE_IDENTITY_REQUIRED");
	if (options.apply && !options.writersQuiesced) throw new TenantPrepareError("TENANT_PREPARE_QUIESCENCE_REQUIRED");
	progress("prepare-identity");
	onQuery("database-identity");
	const identity = await databaseIdentity(connection, queryTimeoutMs);
	if (identity.hostname !== options.expectedHostname || identity.database_name !== options.expectedDatabase)
		throw new TenantPrepareError("TENANT_PREPARE_IDENTITY_MISMATCH");
	const fingerprint = createHash("sha256").update(JSON.stringify([identity.hostname, identity.port, identity.database_name])).digest("hex");
	const lock = scopedLock(identity.database_name, "tenant-prepare");
	let locked = false;
	try {
		if (options.apply) {
			progress("prepare-lock");
			// Dedicated administrative connection: receipts must survive disconnect even if
			// this server defaults to autocommit=0. No business transaction is present here.
			await query("session-autocommit", "SET SESSION autocommit = 1");
			const rows = await query<RowDataPacket[]>("lock-acquire", "SELECT GET_LOCK(?, 0) AS acquired", [lock]);
			if (Number(rows[0]?.["acquired"]) !== 1) throw new TenantPrepareError("TENANT_PREPARE_BUSY");
			locked = true;
		}
		progress("prepare-schema");
		let plan = buildPreparePlan(await inspect());
		if (plan.blockers.length) throw new TenantPrepareError("TENANT_PREPARE_SCHEMA_CONFLICT", plan.blockers);
		let receipts: RowDataPacket[] = [];
		if (plan.journalExists) {
			progress("prepare-journal-check");
			receipts = await query<RowDataPacket[]>("journal-select", `SELECT step_id, tenant, target_fingerprint, manifest_hash, state FROM ${quote(journalTable)} LIMIT 100`);
			const allowed = new Set(["binding", ...Object.keys(legacyContract)]);
			if (receipts.some(row => row["tenant"] !== options.tenant || row["target_fingerprint"] !== fingerprint || row["manifest_hash"] !== manifestHash
				|| !allowed.has(String(row["step_id"])) || !(row["step_id"] === "binding" ? ["PREPARING", "PREPARED"] : ["STARTED", "APPLIED"]).includes(String(row["state"]))))
				throw new TenantPrepareError("TENANT_PREPARE_JOURNAL_CONFLICT");
			if (receipts.length && !receipts.some(row => row["step_id"] === "binding")) throw new TenantPrepareError("TENANT_PREPARE_JOURNAL_CONFLICT");
			if (plan.steps.some(step => receipts.some(row => row["step_id"] === step.id && row["state"] === "APPLIED"))
				|| (plan.steps.length && receipts.some(row => row["step_id"] === "binding" && row["state"] === "PREPARED")))
				throw new TenantPrepareError("TENANT_PREPARE_SCHEMA_DRIFT");
		}
		const report = {
			version: prepareVersion, manifestHash, identity, textProfile: options.profile,
			mode: options.apply ? "apply" : "dry-run", readyForCutover: false, storageContract,
			ddlTimeoutMs: options.ddlTimeoutMs, queryTimeoutMs,
			planned: [...(plan.journalExists ? [] : [{ id: "journal", table: journalTable, sql: journalDdl }]), ...plan.steps],
			metadataVisibility: "Only references and triggers visible to this account were checked.",
		};
		if (!options.apply) return { ...report, status: "PLANNED", schemaChangesRequired: plan.steps.length > 0 || !plan.journalExists };
		progress("prepare-text-probe");
		await probeTenantText(connection, "percent-encoded-v1", queryTimeoutMs, onQuery);
		if (!plan.journalExists) {
			progress("prepare-ddl", "journal");
			await sql(connection, journalDdl, [], options.ddlTimeoutMs);
		}
		const record = async (step: string, state: string) => {
			await query("journal-upsert", `INSERT INTO ${quote(journalTable)} (step_id, tenant, target_fingerprint, manifest_hash, state, updated_at)
				VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = VALUES(updated_at)`,
				[step, options.tenant, fingerprint, manifestHash, state]);
		};
		progress("prepare-journal-start", "binding");
		await record("binding", "PREPARING");
		const applied: string[] = [];
		for (const step of plan.steps) {
			progress("prepare-journal-start", step.id);
			await record(step.id, "STARTED");
			progress("prepare-ddl", step.id);
			await sql(connection, step.sql, [], options.ddlTimeoutMs);
			progress("prepare-verify", step.id);
			const checked = buildPreparePlan(await inspect());
			if (checked.blockers.length || checked.steps.some(item => item.id === step.id))
				throw new TenantPrepareError("TENANT_PREPARE_VERIFY_FAILED", checked.blockers);
			progress("prepare-journal-applied", step.id);
			await record(step.id, "APPLIED");
			applied.push(step.id);
		}
		progress("prepare-final-verify");
		plan = buildPreparePlan(await inspect());
		if (plan.blockers.length || plan.steps.length) throw new TenantPrepareError("TENANT_PREPARE_VERIFY_FAILED", plan.blockers);
		// Includes recovery after DDL succeeded but its receipt was lost. No DDL replay.
		for (const table of Object.keys(legacyContract)) {
			progress("prepare-journal-applied", table);
			await record(table, "APPLIED");
		}
		progress("prepare-journal-complete", "binding");
		await record("binding", "PREPARED");
		progress("prepare-complete");
		return { ...report, status: "PREPARED", applied, textRoundTripPassed: true, schemaChangesRequired: false };
	} finally {
		// A broken session may still be completing DDL on the server. Do not reconnect/retry it here.
		if (locked) { try { await sql(connection, "SELECT RELEASE_LOCK(?)", [lock], queryTimeoutMs); } catch { /* destroyed session; preserve original failure and diagnostic */ } }
	}
}
