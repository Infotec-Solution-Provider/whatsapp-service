import { createHash } from "node:crypto";
import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { databaseIdentity, scopedLock, sql } from "../database/managed-mysql";
import { LOG_COLUMNS, LOG_FIELDS_SQL, LOGS_DDL } from "./schema";

export interface CopyOptions { batchSize: number; maxBatches: number; maxBytes: number; full: boolean; }
export function validateCopyOptions(options: CopyOptions): void {
	for (const [value, max] of [[options.batchSize, 500], [options.maxBatches, 100000], [options.maxBytes, 16777216]]) {
		if (!Number.isSafeInteger(value) || value! < 1 || value! > max!) throw new Error("Invalid copy limits");
	}
}

export async function assertSeparateDatabases(source: PoolConnection, target: PoolConnection) {
	const from = await databaseIdentity(source), to = await databaseIdentity(target);
	if (from.hostname === to.hostname && from.port === to.port && from.database_name.toLowerCase() === to.database_name.toLowerCase()) throw new Error("Source and target must be separate databases");
	return { source: from, target: to, sourceKey: createHash("sha256").update(JSON.stringify(from)).digest("hex") };
}

export async function lockLogStore(target: PoolConnection): Promise<void> {
	const identity = await databaseIdentity(target);
	const rows = await sql<RowDataPacket[]>(target, "SELECT GET_LOCK(?, 0) AS acquired", [scopedLock(identity.database_name, "logs-maintenance")]);
	if (Number(rows[0]?.["acquired"]) !== 1) throw new Error("Log migration or cleanup already running");
}

export async function prepareLogStore(source: PoolConnection, target: PoolConnection): Promise<void> {
	const identity = await assertSeparateDatabases(source, target);
	// Dedicated logs target uses modern DDL; legacy tenants use a different adapter.
	if (!/^8\./.test(identity.target.version)) throw new Error("Dedicated logs database requires validated MySQL 8.x");
	const tables = await sql<RowDataPacket[]>(target, "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
	if (tables.some(row => !["process_log_store", "process_logs", "process_log_copy_state"].includes(String(row["name"])))) throw new Error("Target is not a dedicated logs database");
	if (tables.some(row => row["name"] === "process_logs") && !tables.some(row => row["name"] === "process_log_store")) throw new Error("Unmanaged log table at destination");
	for (const ddl of LOGS_DDL) await sql(target, ddl);
	await sql(target, "INSERT IGNORE INTO process_log_store (id, schema_version, state) VALUES (1, 1, 'COPYING')");
	await sql(target, "INSERT IGNORE INTO process_log_copy_state (id, source_identity) VALUES (1, ?)", [identity.sourceKey]);
	await assertCopying(source, target);
}

async function assertCopying(source: PoolConnection, target: PoolConnection) {
	const identity = await assertSeparateDatabases(source, target);
	const rows = await sql<RowDataPacket[]>(target, "SELECT s.state, s.schema_version, c.source_identity, c.last_id, c.upper_id FROM process_log_store s JOIN process_log_copy_state c ON c.id = s.id WHERE s.id = 1");
	const state = rows[0];
	if (!state || state["state"] !== "COPYING" || Number(state["schema_version"]) !== 1 || state["source_identity"] !== identity.sourceKey) throw new Error("Log store is not in matching copy mode");
	return state;
}

const SIZE_SQL = LOG_COLUMNS.filter(column => !["id", "duration"].includes(column))
	.map(column => `COALESCE(OCTET_LENGTH(\`${column}\`), 0)`).join(" + ");

/** First select IDs/sizes, then fetch a byte-bounded payload batch. */
export async function readLogBatch(source: PoolConnection, cursor: number, upper: number, options: CopyOptions): Promise<RowDataPacket[]> {
	validateCopyOptions(options);
	const candidates = await sql<RowDataPacket[]>(source, `SELECT id, (${SIZE_SQL}) AS bytes FROM process_logs WHERE id > ? AND id <= ? ORDER BY id LIMIT ${options.batchSize}`, [cursor, upper]);
	let bytes = 0;
	const ids: number[] = [];
	for (const row of candidates) {
		const size = Number(row["bytes"]) + 512;
		if (size > options.maxBytes) throw new Error("Log exceeds migration byte limit; inspect size and adjust bounded limit");
		if (bytes + size > options.maxBytes) break;
		bytes += size; ids.push(Number(row["id"]));
	}
	if (!ids.length) return [];
	return sql<RowDataPacket[]>(source, `SELECT ${LOG_FIELDS_SQL} FROM process_logs WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ids);
}

function values(row: RowDataPacket): unknown[] { return LOG_COLUMNS.map(column => row[column]); }

export function logFingerprint(row: Record<string, unknown>): string {
	const fields = LOG_COLUMNS.map(column => {
		const value = row[column];
		if (value === null) return null;
		if (column === "id" || column === "duration") return Number(value);
		if (["start_time", "end_time", "created_at"].includes(column)) return String(value).replace(/\.0+$/, "");
		return value;
	});
	return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export async function copyLogStore(source: PoolConnection, target: PoolConnection, options: CopyOptions) {
	validateCopyOptions(options);
	const state = await assertCopying(source, target);
	const maximum = await sql<RowDataPacket[]>(source, "SELECT COALESCE(MAX(id), 0) AS maximum FROM process_logs");
	const upper = Number(maximum[0]?.["maximum"]);
	let cursor = options.full ? 0 : Number(state["last_id"]);
	if (cursor > upper) throw new Error("Source history changed; full reconciliation required");
	await sql(target, "UPDATE process_log_copy_state SET last_id = ?, upper_id = ?, verified_at = NULL WHERE id = 1", [cursor, upper]);
	let copied = 0, batches = 0;
	for (; batches < options.maxBatches; batches++) {
		const rows = await readLogBatch(source, cursor, upper, options);
		if (!rows.length) return { copied, batches, cursor, upper, complete: true };
		await sql(target, "START TRANSACTION");
		try {
			for (const row of rows) {
				await sql(target, `INSERT INTO process_logs (${LOG_FIELDS_SQL}) VALUES (${LOG_COLUMNS.map(() => "?").join(",")}) ON DUPLICATE KEY UPDATE ${LOG_COLUMNS.filter(column => column !== "id").map(column => `\`${column}\`=VALUES(\`${column}\`)`).join(",")}`, values(row));
			}
			cursor = Number(rows[rows.length - 1]!["id"]);
			await sql(target, "UPDATE process_log_copy_state SET last_id = ?, copied_rows = copied_rows + ? WHERE id = 1", [cursor, rows.length]);
			await sql(target, "COMMIT");
		} catch (error) { target.destroy(); throw error; }
		copied += rows.length;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	return { copied, batches, cursor, upper, complete: cursor === upper };
}

/** Offline final verification: both complete ID sets and each field, not just MAX(id). */
export async function verifyLogStore(source: PoolConnection, target: PoolConnection, options: CopyOptions) {
	await assertCopying(source, target);
	let cursor = 0, checked = 0;
	for (let batch = 0; batch < options.maxBatches; batch++) {
		const rows = await readLogBatch(source, cursor, 2147483647, options);
		if (!rows.length) {
			const extra = await sql<RowDataPacket[]>(target, "SELECT id FROM process_logs WHERE id > ? LIMIT 1", [cursor]);
			if (extra.length) throw new Error("Destination contains extra rows");
			await sql(target, "UPDATE process_log_copy_state SET verified_at = UTC_TIMESTAMP(3) WHERE id = 1");
			return { checked, complete: true };
		}
		const lastId = Number(rows[rows.length - 1]!["id"]);
		const copies = await readLogBatch(target, cursor, lastId, { ...options, batchSize: options.batchSize });
		if (rows.length !== copies.length || rows.some((row, index) => logFingerprint(row) !== logFingerprint(copies[index]!))) throw new Error("Log content or ID mismatch");
		cursor = lastId; checked += rows.length;
	}
	throw new Error("Verification batch limit reached; raise max-batches and rerun verification");
}

/** Both applications must be stopped. Never overwrite a conflicting source ID. */
export async function rollbackLogStore(source: PoolConnection, target: PoolConnection, options: CopyOptions) {
	validateCopyOptions(options);
	const identity = await assertSeparateDatabases(source, target);
	const states = await sql<RowDataPacket[]>(target, "SELECT s.state, c.source_identity, c.rollback_last_id FROM process_log_store s JOIN process_log_copy_state c ON c.id = s.id WHERE s.id = 1");
	const state = states[0];
	if (!state || !["ACTIVE", "PAUSED"].includes(String(state["state"])) || state["source_identity"] !== identity.sourceKey) throw new Error("Invalid rollback source or state");
	await sql(target, "UPDATE process_log_store SET state = 'PAUSED' WHERE id = 1");
	let cursor = options.full ? 0 : Number(state["rollback_last_id"]), copied = 0;
	for (let batch = 0; batch < options.maxBatches; batch++) {
		const rows = await readLogBatch(target, cursor, 2147483647, options);
		if (!rows.length) {
			await sql(target, "UPDATE process_log_store SET state = 'ROLLED_BACK' WHERE id = 1");
			return { copied, complete: true, next: "Resume legacy writers only; dedicated store remains disabled" };
		}
		const ids = rows.map(row => Number(row["id"]));
		const existing = await sql<RowDataPacket[]>(source, `SELECT ${LOG_FIELDS_SQL} FROM process_logs WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
		const byId = new Map(existing.map(row => [Number(row["id"]), row]));
		for (const row of rows) {
			const original = byId.get(Number(row["id"]));
			if (original && logFingerprint(original) !== logFingerprint(row)) throw new Error("Rollback ID collision or content conflict; both writers must remain stopped");
		}
		await sql(source, "START TRANSACTION");
		for (const row of rows) {
			if (byId.has(Number(row["id"]))) continue;
			await sql(source, `INSERT INTO process_logs (${LOG_FIELDS_SQL}) VALUES (${LOG_COLUMNS.map(() => "?").join(",")})`, values(row));
			copied++;
		}
		await sql(source, "COMMIT");
		cursor = ids[ids.length - 1]!;
		// Commit before checkpoint: replay after a crash compares existing content.
		await sql(target, "UPDATE process_log_copy_state SET rollback_last_id = ? WHERE id = 1", [cursor]);
	}
	return { copied, complete: false, cursor };
}
