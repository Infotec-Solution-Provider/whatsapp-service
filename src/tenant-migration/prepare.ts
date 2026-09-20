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
	progress: (stage: string, step?: string) => void;
}

/** DDL commits independently. Resume by inspecting the real schema, never by blindly replaying SQL. */
export async function prepareTenant(connection: PoolConnection, options: PrepareOptions) {
	if (options.profile !== "percent-encoded-v1") throw new TenantPrepareError("TENANT_PREPARE_PROFILE_UNSUPPORTED");
	if (!options.expectedHostname || !options.expectedDatabase) throw new TenantPrepareError("TENANT_PREPARE_IDENTITY_REQUIRED");
	if (options.apply && !options.writersQuiesced) throw new TenantPrepareError("TENANT_PREPARE_QUIESCENCE_REQUIRED");
	options.progress("prepare-identity");
	const identity = await databaseIdentity(connection);
	if (identity.hostname !== options.expectedHostname || identity.database_name !== options.expectedDatabase)
		throw new TenantPrepareError("TENANT_PREPARE_IDENTITY_MISMATCH");
	const fingerprint = createHash("sha256").update(JSON.stringify([identity.hostname, identity.port, identity.database_name])).digest("hex");
	const lock = scopedLock(identity.database_name, "tenant-prepare");
	let locked = false;
	try {
		if (options.apply) {
			options.progress("prepare-lock");
			// Dedicated administrative connection: receipts must survive disconnect even if
			// this server defaults to autocommit=0. No business transaction is present here.
			await sql(connection, "SET SESSION autocommit = 1");
			const rows = await sql<RowDataPacket[]>(connection, "SELECT GET_LOCK(?, 0) AS acquired", [lock]);
			if (Number(rows[0]?.["acquired"]) !== 1) throw new TenantPrepareError("TENANT_PREPARE_BUSY");
			locked = true;
		}
		options.progress("prepare-schema");
		let plan = buildPreparePlan(await inspectWppSchema(connection));
		if (plan.blockers.length) throw new TenantPrepareError("TENANT_PREPARE_SCHEMA_CONFLICT", plan.blockers);
		let receipts: RowDataPacket[] = [];
		if (plan.journalExists) {
			options.progress("prepare-journal-check");
			receipts = await sql<RowDataPacket[]>(connection, `SELECT step_id, tenant, target_fingerprint, manifest_hash, state FROM ${quote(journalTable)} LIMIT 100`);
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
			ddlTimeoutMs: options.ddlTimeoutMs,
			planned: [...(plan.journalExists ? [] : [{ id: "journal", table: journalTable, sql: journalDdl }]), ...plan.steps],
			metadataVisibility: "Only references and triggers visible to this account were checked.",
		};
		if (!options.apply) return { ...report, status: "PLANNED", schemaChangesRequired: plan.steps.length > 0 || !plan.journalExists };
		options.progress("prepare-text-probe");
		await probeTenantText(connection, "percent-encoded-v1");
		if (!plan.journalExists) {
			options.progress("prepare-ddl", "journal");
			await sql(connection, journalDdl, [], options.ddlTimeoutMs);
		}
		const record = async (step: string, state: string) => {
			await sql(connection, `INSERT INTO ${quote(journalTable)} (step_id, tenant, target_fingerprint, manifest_hash, state, updated_at)
				VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = VALUES(updated_at)`,
				[step, options.tenant, fingerprint, manifestHash, state]);
		};
		await record("binding", "PREPARING");
		const applied: string[] = [];
		for (const step of plan.steps) {
			options.progress("prepare-journal-start", step.id);
			await record(step.id, "STARTED");
			options.progress("prepare-ddl", step.id);
			await sql(connection, step.sql, [], options.ddlTimeoutMs);
			options.progress("prepare-verify", step.id);
			const checked = buildPreparePlan(await inspectWppSchema(connection));
			if (checked.blockers.length || checked.steps.some(item => item.id === step.id))
				throw new TenantPrepareError("TENANT_PREPARE_VERIFY_FAILED", checked.blockers);
			await record(step.id, "APPLIED");
			applied.push(step.id);
		}
		plan = buildPreparePlan(await inspectWppSchema(connection));
		if (plan.blockers.length || plan.steps.length) throw new TenantPrepareError("TENANT_PREPARE_VERIFY_FAILED", plan.blockers);
		// Includes recovery after DDL succeeded but its receipt was lost. No DDL replay.
		for (const table of Object.keys(legacyContract)) await record(table, "APPLIED");
		await record("binding", "PREPARED");
		options.progress("prepare-complete");
		return { ...report, status: "PREPARED", applied, textRoundTripPassed: true, schemaChangesRequired: false };
	} finally {
		// A broken session may still be completing DDL on the server. Do not reconnect/retry it here.
		if (locked) { try { await sql(connection, "SELECT RELEASE_LOCK(?)", [lock]); } catch { /* destroyed session; preserve original failure */ } }
	}
}
