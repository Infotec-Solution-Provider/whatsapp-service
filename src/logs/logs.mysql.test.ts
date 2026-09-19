import assert from "node:assert/strict";
import test from "node:test";
import mysql, { RowDataPacket } from "mysql2/promise";
import { acquire, createManagedPool, sql } from "../database/managed-mysql";
import { cleanProcessLogs } from "./cleanup";
import { readLogsConfig } from "./config";
import { copyLogStore, lockLogStore, prepareLogStore, rollbackLogStore, verifyLogStore } from "./migrate";
import { LOG_COLUMNS, LOG_FIELDS_SQL, LOGS_DDL } from "./schema";
import { ProcessLogsService } from "./service";
import { inspectTenantDatabase, probeTenantText } from "../tenant-migration/inspect";

const enabled = process.env["RUN_MIGRATION_MYSQL_TESTS"] === "true";

test("real MySQL: restartable log migration, content verification, gated writes and bounded daily retention", { skip: !enabled }, async () => {
	const admin = await mysql.createConnection({ host: "127.0.0.1", port: 13318, user: "root" });
	const suffix = `${process.pid}_${Date.now()}`;
	const sourceName = `migration_test_source_${suffix}`, targetName = `migration_test_logs_${suffix}`;
	await admin.query(`CREATE DATABASE \`${sourceName}\``); await admin.query(`CREATE DATABASE \`${targetName}\``);
	const sourcePool = createManagedPool(`mysql://root@127.0.0.1:13318/${sourceName}`, 2);
	const targetUrl = `mysql://root@127.0.0.1:13318/${targetName}`;
	const targetPool = createManagedPool(targetUrl, 3);
	const source = await acquire(sourcePool), target = await acquire(targetPool);
	const now = new Date("2026-09-20T22:00:00Z");
	const config = readLogsConfig({ PROCESS_LOG_STORAGE: "dedicated", LOGS_DATABASE_URL: targetUrl, PROCESS_LOG_CLEANUP_ENABLED: "true", PROCESS_LOG_CLEANUP_BATCH_SIZE: "1" });
	const options = { batchSize: 2, maxBatches: 100, maxBytes: 1048576, full: false };
	try {
		await sql(source, LOGS_DDL[1]);
		for (const [id, status, days] of [[1, "SUCCESS", 8], [2, "SUCCESS", 7], [3, "FAILED", 31], [4, "FAILED", 8], [5, "OTHER", 90], [6, "FAILED ", 90]] as const) {
			const at = new Date(now.getTime() - days * 86400000);
			await sql(source, `INSERT INTO process_logs (${LOG_FIELDS_SQL}) VALUES (${LOG_COLUMNS.map(() => "?").join(",")})`, [id, "tenant", "fixture", `p${id}`, status, at, at, 1, "ação 😀 %20", "", null, null, "[]", at]);
		}
		await lockLogStore(target); await prepareLogStore(source, target);
		const blockedWriter = new ProcessLogsService({ ...config, maxPending: 1 });
		const blockedRecord = { instance: "tenant", processName: "fixture", processId: "blocked", status: "SUCCESS" as const, startTime: now, endTime: now, duration: 0, input: "", output: "", error: "", errorMessage: "", logEntries: "[]" };
		blockedWriter.save(blockedRecord); blockedWriter.save(blockedRecord);
		await blockedWriter.stop();
		assert.deepEqual(blockedWriter.metrics, { saved: 0, failed: 1, rejected: 1 });
		assert.equal((await copyLogStore(source, target, { ...options, maxBatches: 1 })).complete, false);
		assert.equal((await copyLogStore(source, target, options)).complete, true);
		await copyLogStore(source, target, { ...options, full: true });
		assert.equal((await verifyLogStore(source, target, options)).checked, 6);
		const faithful = await sql<RowDataPacket[]>(target, "SELECT input, output, error FROM process_logs WHERE id = 1");
		assert.equal(faithful[0]?.["input"], "ação 😀 %20");
		assert.equal(faithful[0]?.["output"], ""); assert.equal(faithful[0]?.["error"], null);
		await sql(target, "UPDATE process_logs SET input = 'corrupted' WHERE id = 2");
		await assert.rejects(verifyLogStore(source, target, options), /mismatch/);
		await copyLogStore(source, target, { ...options, full: true });
		await verifyLogStore(source, target, options);
		assert.equal((await cleanProcessLogs(targetPool, config, { now })).skipped, "busy");
		await sql(target, "UPDATE process_log_store SET state = 'ACTIVE' WHERE id = 1");
		target.destroy();
		assert.equal((await cleanProcessLogs(targetPool, config, { now: new Date("2026-09-20T12:00:00Z") })).skipped, "outside_schedule_or_disabled");
		const preview = await cleanProcessLogs(targetPool, config, { now, dryRun: true });
		assert.equal(preview.success, 1); assert.equal(preview.failed, 1);
		const actual = await cleanProcessLogs(targetPool, config, { now });
		assert.equal(actual.success, 1); assert.equal(actual.failed, 1);
		assert.equal((await cleanProcessLogs(targetPool, config, { now })).skipped, "already_executed");
		const check = await acquire(targetPool);
		try {
			const rows = await sql<RowDataPacket[]>(check, "SELECT id FROM process_logs ORDER BY id");
			assert.deepEqual(rows.map(row => Number(row["id"])), [2, 4, 5, 6]);
		} finally { check.release(); }
		const runtime = new ProcessLogsService(config);
		runtime.save({ instance: "tenant", processName: "runtime", processId: "new", status: "SUCCESS", startTime: now, endTime: now, duration: 0, input: "😀", output: "", error: "null", errorMessage: "", logEntries: "[]" });
		await runtime.stop(); assert.equal(runtime.metrics.saved, 1);
		const sourceRows = await sql<RowDataPacket[]>(source, "SELECT id FROM process_logs ORDER BY id");
		assert.equal(sourceRows.length, 6, "source data must not be deleted");
		const rollback = await acquire(targetPool);
		try {
			await lockLogStore(rollback);
			await sql(rollback, "UPDATE process_logs SET input = 'conflict' WHERE id = 2");
			await assert.rejects(rollbackLogStore(source, rollback, options), /conflict/);
			await sql(rollback, "UPDATE process_logs SET input = ? WHERE id = 2", ["ação 😀 %20"]);
			assert.equal((await rollbackLogStore(source, rollback, options)).copied, 1);
			const after = await sql<RowDataPacket[]>(source, "SELECT id, input FROM process_logs WHERE process_id = 'new'");
			assert.equal(after[0]?.["input"], "😀");
		} finally { rollback.destroy(); }
	} finally {
		source.destroy(); target.destroy(); await sourcePool.end(); await targetPool.end();
		await admin.query(`DROP DATABASE \`${sourceName}\``); await admin.query(`DROP DATABASE \`${targetName}\``); await admin.end();
	}
});

test("real MySQL 5.5: Latin-1 database defaults with isolated utf8mb4 connection/tables preserve Unicode bytes", { skip: !enabled }, async () => {
	const admin = await mysql.createConnection({ host: "127.0.0.1", port: 13355, user: "root" });
	const database = `migration_test_legacy_${process.pid}_${Date.now()}`;
	await admin.query(`CREATE DATABASE \`${database}\` DEFAULT CHARACTER SET latin1 COLLATE latin1_swedish_ci`);
	const pool = createManagedPool(`mysql://root@127.0.0.1:13355/${database}`, 1);
	const connection = await acquire(pool);
	try {
		const report = await inspectTenantDatabase(connection);
		assert.match(report.identity.version, /^5\.5\./);
		assert.equal(report.settings["character_set_database"], "latin1");
		assert.equal(report.settings["character_set_connection"], "utf8mb4");
		assert.equal(report.readyForCutover, false);
		await probeTenantText(connection);
		await sql(connection, "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_BACKSLASH_ESCAPES'");
		await probeTenantText(connection);
	} finally { connection.destroy(); await pool.end(); await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); }
});
