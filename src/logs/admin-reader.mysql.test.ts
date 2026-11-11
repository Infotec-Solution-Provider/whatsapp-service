import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql, { RowDataPacket } from "mysql2/promise";
import { ProcessLogsService } from "./service";
import defaultLogs from "./service";
import { readLogsConfig } from "./config";
import { processingLogs, processingLogTimestamp } from "../admin/processing-logs";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { LOGS_DDL } from "./schema";

const fixtureUrl = process.env["ADMIN_LOGS_MYSQL_TEST_URL"];
test("legacy administrative logs use their explicit owner in tenant-sql mode and indexed time windows", { skip: !fixtureUrl }, async () => {
  const url = new URL(fixtureUrl!);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && ["13318", "13379"].includes(url.port), "Only a disposable local fixture is permitted");
  const database = `infotec_admin_logs_reader_${process.pid}_${Date.now()}`;
  const admin = await mysql.createConnection({ uri: fixtureUrl!, timezone: "Z" });
  const previousUrl = process.env["WHATSAPP_DATABASE_URL"], previousStorage = process.env["WHATSAPP_STORAGE"];
  const service = new ProcessLogsService(readLogsConfig({ PROCESS_LOG_STORAGE: "legacy" }));
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); await admin.query(`USE \`${database}\``);
    await admin.query(LOGS_DDL[1].replace(/,\s*INDEX process_logs_instance_created_at_id_idx[^\n]+/, ""));
    const now = new Date(), recent = new Date(now.getTime() - 60000), old = new Date(now.getTime() - 7 * 86400000);
    for (let batch = 0; batch < 10; batch++) {
      const values = Array.from({ length: 500 }, (_, index) => ["homolog", "fixture", `${batch}-${index}`, "SUCCESS", old, old, 0, old]);
      await admin.query("INSERT INTO process_logs(instance,process_name,process_id,status,start_time,end_time,duration,created_at) VALUES ?", [values]);
    }
    for (const tenant of ["homolog", "homolog", "other"])
      await admin.execute("INSERT INTO process_logs(instance,process_name,process_id,status,start_time,end_time,duration,created_at) VALUES(?,?,?,?,?,?,?,?)", [tenant, "fixture", "recent", "SUCCESS", recent, recent, 0, recent]);
    url.pathname = `/${database}`; process.env["WHATSAPP_DATABASE_URL"] = url.toString(); process.env["WHATSAPP_STORAGE"] = "tenant-sql";
    const statement = "SELECT id,instance,created_at FROM process_logs WHERE created_at>=? AND created_at<=? AND instance=? ORDER BY id DESC LIMIT ?";
    const values = [new Date(now.getTime() - 3600000), now, "homolog", "6"];
    const [before] = await admin.execute<RowDataPacket[]>(`EXPLAIN ${statement}`, values);
    const migration = readFileSync(path.resolve(__dirname, "../../prisma/migrations/20261111142000_process_logs_admin_window/migration.sql"), "utf8");
    await admin.query(migration);
    const [after] = await admin.execute<RowDataPacket[]>(`EXPLAIN ${statement}`, values);
    assert.equal(after[0]?.["key"], "process_logs_instance_created_at_id_idx", "The time window must use the tenant/time index");
    assert.notEqual(after[0]?.["type"], "ALL");
    const rows = await withDatabaseTenant("unrelated-tenant-context", () => service.readAdminPage(statement, values));
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row["instance"] === "homolog"));
    assert.ok(rows.every(row => processingLogTimestamp(row["created_at"]) === recent.toISOString()));
    const page = await processingLogs({ action: "getLogs", environment: "homolog", tenant: "homolog", from: new Date(now.getTime() - 3600000).toISOString(), to: now.toISOString(), limit: 1 });
    assert.equal(page.entries.length, 1); assert.equal(page.truncated, true); assert.ok(page.nextCursor);
    assert.equal(page.entries[0]?.timestamp, recent.toISOString());
    const next = await processingLogs({ action: "getLogs", environment: "homolog", tenant: "homolog", from: new Date(now.getTime() - 3600000).toISOString(), to: now.toISOString(), limit: 1, cursor: page.nextCursor });
    assert.equal(next.entries.length, 1); assert.notEqual(next.entries[0]?.id, page.entries[0]?.id); assert.equal(next.truncated, false);
    await service.stop();
    await assert.rejects(service.readAdminPage(statement, values), "Stopping the service must close its separate legacy read pool");
    const output = process.env["ADMIN_LOGS_MYSQL_EXPLAIN_OUTPUT"];
    if (output) writeFileSync(output, JSON.stringify({ localFixture: true, before, after, rowsReturned: rows.length, stoppedReaderPoolClosed: true }, null, 2));
  } finally {
    await service.stop().catch(() => undefined);
    await defaultLogs.stop().catch(() => undefined);
    if (previousUrl === undefined) delete process.env["WHATSAPP_DATABASE_URL"]; else process.env["WHATSAPP_DATABASE_URL"] = previousUrl;
    if (previousStorage === undefined) delete process.env["WHATSAPP_STORAGE"]; else process.env["WHATSAPP_STORAGE"] = previousStorage;
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end();
  }
});
