import assert from "node:assert/strict";
import test from "node:test";
import { cleanupScheduleOptions, readLogsConfig, retentionCutoffs } from "./config";
import { cleanupSlot } from "./cleanup";
import { serializeLog } from "./serialize";
import { decodeTenantText, encodeTenantText, transcodeTenantText } from "../tenant-migration/encoding";
import { mysqlOptions } from "../database/managed-mysql";
import { parseLogsMigrationArgs } from "../scripts/migrate-logs";
import processLogs, { ProcessLogRecord } from "./service";
import ProcessingLogger from "../utils/processing-logger";

test("retention configuration: separate defaults, zero preservation and invalid values fail closed", () => {
	const config = readLogsConfig({});
	assert.equal(config.successDays, 7); assert.equal(config.failedDays, 30);
	assert.equal(config.cleanupEnabled, false);
	assert.equal(retentionCutoffs(readLogsConfig({ PROCESS_LOG_RETENTION_SUCCESS_DAYS: "0" }), new Date()).length, 1);
	assert.equal(retentionCutoffs(readLogsConfig({ PROCESS_LOG_RETENTION_SUCCESS_DAYS: "0", PROCESS_LOG_RETENTION_FAILED_DAYS: "0" }), new Date()).length, 0);
	for (const bad of ["-1", "1.5", "NaN", "Infinity", " 7"]) assert.throws(() => readLogsConfig({ PROCESS_LOG_RETENTION_SUCCESS_DAYS: bad }));
	assert.throws(() => readLogsConfig({ PROCESS_LOG_CLEANUP_ENABLED: "true" }));
	assert.throws(() => readLogsConfig({ PROCESS_LOG_CLEANUP_CRON: "* * * * *" }));
	assert.throws(() => readLogsConfig({ PROCESS_LOG_CLEANUP_TIMEZONE: "invalid" }));
});

test("19h Sao Paulo schedule is independent of host timezone and does not recover missed runs", () => {
	const config = readLogsConfig({});
	assert.equal(cleanupSlot(config, new Date("2026-09-19T22:00:00Z")), "2026-09-19 19:00");
	assert.equal(cleanupSlot(config, new Date("2026-09-19T19:00:00Z")), null);
	assert.equal(cleanupSlot(config, new Date("2026-09-19T22:01:00Z")), null);
	assert.deepEqual(cleanupScheduleOptions(config.timezone), { scheduled: true, timezone: "America/Sao_Paulo", recoverMissedExecutions: false, runOnInit: false });
});

test("sanitization is bounded, handles cycles/BigInt, does not execute getters or print credentials", () => {
	let getterRead = false;
	const data: Record<string, unknown> = { token: "private-token", request: { password: "private-password" }, message: "Bearer abcdef mysql://user:secret@host/db", big: 2n };
	data["self"] = data;
	Object.defineProperty(data, "getter", { enumerable: true, get() { getterRead = true; return "private"; } });
	const result = serializeLog(data);
	assert.equal(getterRead, false); assert.doesNotMatch(result, /private-token|private-password|abcdef|user:secret/);
	assert.match(result, /Circular/); assert.match(result, /"big":"2"/);
	assert.ok(Buffer.byteLength(serializeLog("😀".repeat(100000))) <= 32768);
	assert.doesNotThrow(() => JSON.parse(serializeLog({ toJSON() { throw new Error("no"); } })));
});

test("text profiles preserve null, empty, accents, emojis, literal percent escapes and reject invalid encoding", () => {
	for (const value of [null, "", "Ação São João", "👩🏽‍💻 中文", "%20 %25", "https://x/a%20b", "e\u0301"]) {
		for (const profile of ["utf8mb4-native-v1", "percent-encoded-v1"] as const) assert.equal(decodeTenantText(encodeTenantText(value, profile), profile), value);
		assert.equal(transcodeTenantText(encodeTenantText(value, "percent-encoded-v1"), "percent-encoded-v1", "utf8mb4-native-v1"), value);
	}
	assert.equal(decodeTenantText("%20", "utf8mb4-native-v1"), "%20");
	assert.throws(() => decodeTenantText("%broken", "percent-encoded-v1"));
	assert.throws(() => encodeTenantText("\ud800", "utf8mb4-native-v1"));
});

test("migration requires explicit offline final verification; URLs never enable multiple statements or downgrade TLS", () => {
	assert.throws(() => parseLogsMigrationArgs(["--phase", "activate"]));
	assert.equal(parseLogsMigrationArgs(["--phase", "activate", "--source-quiesced"]).quiesced, true);
	assert.throws(() => parseLogsMigrationArgs(["--phase", "drop"]));
	assert.equal(mysqlOptions("mysql://localhost/db").multipleStatements, false);
	assert.equal(mysqlOptions("mysql://localhost/db?sslmode=require").ssl && true, true);
	assert.throws(() => mysqlOptions("mysql://localhost/db?sslmode=prefer"));
	assert.throws(() => mysqlOptions("mysql://localhost/db?multipleStatements=true"));
});

test("logger snapshots inputs, records falsey failures and completes only once", () => {
	const records: ProcessLogRecord[] = [];
	const original = processLogs.save;
	processLogs.save = record => { records.push(record); };
	try {
		const input = { text: "original", password: "secret" };
		const logger = new ProcessingLogger("tenant", "test", "id", input);
		input.text = "changed";
		logger.failed(null); logger.success("late"); logger.failed(new Error("late"));
		assert.equal(records.length, 1); assert.equal(records[0]?.status, "FAILED");
		assert.deepEqual(JSON.parse(records[0]!.input), { text: "original", password: "[REDACTED]" });
	} finally { processLogs.save = original; }
});
