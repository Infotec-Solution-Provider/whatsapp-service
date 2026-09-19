import { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { acquire, databaseIdentity, scopedLock, sql } from "../database/managed-mysql";
import { LogsConfig, retentionCutoffs } from "./config";

export function cleanupSlot(config: LogsConfig, now: Date): string | null {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
		timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
	}).formatToParts(now).map(part => [part.type, part.value]));
	const [minute, hour] = config.cron.split(" ").map(Number);
	if (Number(parts["hour"]) !== hour || Number(parts["minute"]) !== minute) return null;
	return `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]}`;
}

export async function cleanProcessLogs(pool: Pool, config: LogsConfig, options: { dryRun?: boolean; now?: Date; stopped?: () => boolean } = {}) {
	const now = options.now ?? new Date();
	const dryRun = options.dryRun ?? false;
	const slot = cleanupSlot(config, now);
	const result = { dryRun, skipped: "", batches: 0, success: 0, failed: 0, limited: false };
	if (!dryRun && (!config.cleanupEnabled || !slot)) return { ...result, skipped: "outside_schedule_or_disabled" };
	const cutoffs = retentionCutoffs(config, now);
	if (!cutoffs.length) return { ...result, skipped: "retained_indefinitely" };
	const started = Date.now();
	const connection = await acquire(pool);
	try {
		const identity = await databaseIdentity(connection);
		const lock = scopedLock(identity.database_name, "logs-maintenance");
		const locked = await sql<RowDataPacket[]>(connection, "SELECT GET_LOCK(?, 0) AS acquired", [lock]);
		if (Number(locked[0]?.["acquired"]) !== 1) return { ...result, skipped: "busy" };
		const state = await sql<RowDataPacket[]>(connection, "SELECT schema_version, state, last_cleanup_slot FROM process_log_store WHERE id = 1");
		const allowedStates = dryRun ? ["COPYING", "ACTIVE"] : ["ACTIVE"];
		if (!allowedStates.includes(String(state[0]?.["state"])) || Number(state[0]?.["schema_version"]) !== 1) return { ...result, skipped: "store_not_active" };
		if (!dryRun) {
			if (state[0]?.["last_cleanup_slot"] === slot) return { ...result, skipped: "already_executed" };
			await sql(connection, "UPDATE process_log_store SET last_cleanup_slot = ? WHERE id = 1", [slot]);
		}
		await sql(connection, "SET SESSION innodb_lock_wait_timeout = 2");
		const cursors = new Map<string, { created: string; id: number }>();
		const exhausted = new Set<string>();
		while (result.batches < config.maxBatches && exhausted.size < cutoffs.length) {
			for (const item of cutoffs) {
				if (exhausted.has(item.status)) continue;
				if (options.stopped?.() || Date.now() - started >= config.maxDurationMs || result.batches >= config.maxBatches) {
					result.limited = true; return result;
				}
				const remaining = Math.max(1, Math.min(3000, config.maxDurationMs - (Date.now() - started)));
				let count: number;
				if (dryRun) {
					const cursor = cursors.get(item.status);
					const after = cursor ? " AND (created_at > ? OR (created_at = ? AND id > ?))" : "";
					const values: unknown[] = [item.status, item.status, item.cutoff];
					if (cursor) values.push(cursor.created, cursor.created, cursor.id);
					const rows = await sql<RowDataPacket[]>(connection, `SELECT id, created_at FROM process_logs WHERE status = ? AND BINARY status = BINARY ? AND created_at < ?${after} ORDER BY created_at, id LIMIT ${config.batchSize}`, values, remaining);
					count = rows.length;
					const last = rows[rows.length - 1];
					if (last) cursors.set(item.status, { id: Number(last["id"]), created: String(last["created_at"]) });
				} else {
					const deleted = await sql<ResultSetHeader>(connection, `DELETE FROM process_logs WHERE status = ? AND BINARY status = BINARY ? AND created_at < ? ORDER BY created_at, id LIMIT ${config.batchSize}`, [item.status, item.status, item.cutoff], remaining);
					count = deleted.affectedRows;
				}
				result.batches++;
				if (item.status === "SUCCESS") result.success += count; else result.failed += count;
				if (count < config.batchSize) exhausted.add(item.status);
				if (!dryRun) await new Promise(resolve => setTimeout(resolve, 100));
			}
		}
		result.limited = exhausted.size < cutoffs.length;
		return result;
	} finally { connection.destroy(); }
}
