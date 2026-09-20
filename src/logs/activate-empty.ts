import { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { sql } from "../database/managed-mysql";
import { assertSeparateDatabases, CopyOptions, validateCopyOptions } from "./migrate";

/** Called under logs-maintenance lock, with ALL writers stopped. Never modifies source data. */
export async function activateEmptyLogStore(source: PoolConnection, target: PoolConnection, options: CopyOptions) {
	validateCopyOptions(options);
	const identity = await assertSeparateDatabases(source, target);
	if (!/^8\./.test(identity.target.version)) throw new Error("Dedicated logs database requires validated MySQL 8.x");
	const states = await sql<RowDataPacket[]>(target, "SELECT s.state, s.schema_version, c.source_identity FROM process_log_store s JOIN process_log_copy_state c ON c.id = s.id WHERE s.id = 1");
	const state = states[0];
	if (!state || !["COPYING", "RESETTING"].includes(String(state["state"])) || Number(state["schema_version"]) !== 1 || state["source_identity"] !== identity.sourceKey) {
		throw new Error("Fresh activation requires a matching, never-activated copy; ACTIVE/PAUSED/ROLLED_BACK stores cannot be cleared");
	}
	// Preserve rollback compatibility: new IDs must not collide with retained source history.
	const sourceMaximum = await sql<RowDataPacket[]>(source, "SELECT COALESCE(MAX(id), 0) AS maximum FROM process_logs");
	const targetMaximum = await sql<RowDataPacket[]>(target, "SELECT COALESCE(MAX(id), 0) AS maximum FROM process_logs");
	const sourceSequence = await sql<RowDataPacket[]>(source, "SELECT AUTO_INCREMENT AS next_id FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'process_logs'");
	const targetSequence = await sql<RowDataPacket[]>(target, "SELECT AUTO_INCREMENT AS next_id FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'process_logs'");
	const nextId = Math.max(Number(sourceMaximum[0]?.["maximum"]) + 1, Number(targetMaximum[0]?.["maximum"]) + 1,
		Number(sourceSequence[0]?.["next_id"] ?? 1), Number(targetSequence[0]?.["next_id"] ?? 1));
	if (!Number.isSafeInteger(nextId) || nextId < 1 || nextId > 2147483647) throw new Error("Log ID range exhausted or invalid; fresh activation stopped");
	// Execute before deletion: missing ALTER privileges must not leave a partially cleared store.
	await sql(target, `ALTER TABLE process_logs AUTO_INCREMENT = ${nextId}`);
	await sql(target, "UPDATE process_log_store SET state = 'RESETTING' WHERE id = 1");
	await sql(target, "SET SESSION innodb_lock_wait_timeout = 2");
	let deleted = 0, batches = 0;
	for (; batches < options.maxBatches; batches++) {
		const result = await sql<ResultSetHeader>(target, `DELETE FROM process_logs ORDER BY id LIMIT ${options.batchSize}`);
		deleted += result.affectedRows;
		if (result.affectedRows < options.batchSize) { batches++; break; }
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	const remaining = await sql<RowDataPacket[]>(target, "SELECT id FROM process_logs LIMIT 1");
	if (remaining.length) return { deleted, batches, complete: false, activated: false, next: "Repeat activate-empty with writers still stopped" };
	await sql(target, "START TRANSACTION");
	try {
		await sql(target, "UPDATE process_log_copy_state SET last_id = 0, upper_id = ?, rollback_last_id = 0, copied_rows = 0, verified_at = NULL WHERE id = 1", [Number(sourceMaximum[0]?.["maximum"])]);
		await sql(target, "UPDATE process_log_store SET state = 'ACTIVE', last_cleanup_slot = NULL WHERE id = 1 AND state = 'RESETTING'");
		await sql(target, "COMMIT");
	} catch (error) { target.destroy(); throw error; }
	return { deleted, batches, complete: true, activated: true, nextId, historyCopied: false, next: "Start dedicated writers only; source history is unchanged" };
}
