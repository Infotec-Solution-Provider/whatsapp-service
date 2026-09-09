"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseArgs, selectPm2, parseProc, safeError, databaseConfig, captureDatabase } = require("./capture-resource-incident.cjs");

test("requires a PM2 id and bounds capture duration and cadence", () => {
  assert.deepEqual(parseArgs(["--pm2-id", "13", "--db"]), { pm2Id: 13, samples: 12, intervalMs: 5000, db: true, help: false });
  for (const args of [[], ["--pm2-id", "13;secret"], ["--pm2-id", "13", "--samples", "100000"], ["--pm2-id", "13", "--interval-ms", "0"]]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(["--help"]).help, true);
});

test("PM2 output only contains allowlisted numeric metrics, never credentials or injected labels", () => {
  const result = selectPm2({
    pm_id: 13, pid: 42, monit: { memory: 1024, cpu: 1.5 }, secret: "private",
    pm2_env: {
      WHATSAPP_DATABASE_URL: "mysql://private:password@host/db", restart_time: 52, pm_uptime: 123,
      axm_monitor: { "Used Heap Size": { value: "53.6" }, "Heap Size": { value: "private" }, private: { value: "token" } }
    }
  });
  assert.equal(result.heap_used_mib, 53.6);
  assert.equal(result.heap_total_mib, null);
  assert.equal(result.restart_count, 52);
  assert.doesNotMatch(JSON.stringify(result), /private|password|token|mysql/);
});

test("proc parser preserves bytes versus thread count and ignores nonnumeric fields", () => {
  const result = parseProc("Name:\tprivate\nVmRSS:\t2048 kB\nThreads:\t17\nVmSwap:\t16 kB\nUnselected:\t77 kB\n", ["VmRSS", "Threads", "VmSwap"]);
  assert.deepEqual(result, { VmRSS: 2097152, Threads: 17, VmSwap: 16384 });
});

test("only recognized failure codes escape; database TLS options never silently downgrade", () => {
  assert.equal(safeError({ code: "EACCES", message: "private password" }), "EACCES");
  assert.equal(safeError({ code: "private", message: "private password" }), "capture_failed");
  const config = databaseConfig("mysql://worker:p%40ss@localhost:3307/whatsapp?connection_limit=17&pool_timeout=10");
  assert.equal(config.password, "p@ss");
  assert.equal(config.port, 3307);
  assert.equal(config.multipleStatements, false);
  assert.throws(() => databaseConfig("mysql://worker:private@host/db?sslaccept=strict"));
  assert.throws(() => databaseConfig("postgres://worker:private@host/db"));
});

test("socket URLs never silently connect through TCP and IPv6 literals are normalized for mysql2", () => {
  for (const key of ["socket", "socketPath", "SOCKET"]) {
    assert.throws(() => databaseConfig(`mysql://worker:private@localhost/db?${key}=%2Fvar%2Frun%2Fmysql.sock`), /unsupported_database_configuration/);
  }
  const config = databaseConfig("mysql://worker:private@[::1]:3307/whatsapp");
  assert.equal(config.host, "::1");
  assert.equal(config.port, 3307);
});

test("explicit sslmode=disable connects without TLS while preserving URL decoding and pool independence", () => {
  const config = databaseConfig("mysql://worker:p%40ss@localhost:3307/whatsapp?sslmode=disable&connection_limit=17&pool_timeout=10");
  assert.equal(config.ssl, false);
  assert.equal(config.host, "localhost");
  assert.equal(config.port, 3307);
  assert.equal(config.password, "p@ss");
  assert.equal(config.database, "whatsapp");
  assert.equal(config.connectionLimit, undefined);
});

test("sslmode=disable cannot mask conflicting SSL/TLS/socket options or ambiguous spellings", () => {
  for (const query of [
    "sslmode=require", "sslmode=prefer", "sslmode=DISABLE", "SSLMODE=disable",
    "sslmode=disable&sslmode=require", "sslmode=disable&sslmode=disable",
    "sslmode=disable&sslaccept=strict", "sslmode=disable&sslcert=%2Ftmp%2Fca.pem",
    "sslmode=disable&tls=true", "sslmode=disable&tlsMode=require",
    "sslmode=disable&socket=%2Ftmp%2Fmysql.sock", "sslmode=disable&socketPath=%2Ftmp%2Fmysql.sock"
  ]) {
    assert.throws(() => databaseConfig(`mysql://worker:fake@localhost/whatsapp?${query}`), /unsupported_database_configuration/);
  }
});

test("database capture reads metadata, filters by target account, and tolerates denied trx visibility", async () => {
  const calls = [];
  const connection = { query: async (options) => {
    calls.push(options);
    assert.match(options.sql, /^(SELECT|SHOW) /);
    assert.equal(options.timeout, 3000);
    assert.doesNotMatch(options.sql, /trx_query|\bINFO\b|\bSET\b|\bUPDATE\b/i);
    if (options.sql.includes("innodb_trx")) throw { code: "ER_SPECIFIC_ACCESS_DENIED_ERROR", message: "private password" };
    if (options.sql.includes("PROCESSLIST")) return [[{ id: 15, command: "Sleep", seconds: 2 }]];
    if (options.sql.startsWith("SHOW")) return [[{ Variable_name: "Threads_connected", Value: "34" }]];
    return [[{ hostname: "test-server", collector_connection_id: 10 }]];
  } };
  const result = await captureDatabase(connection, "whatsapp");
  assert.equal(result.status.Threads_connected, 34);
  assert.deepEqual(result.transactions, { error: "ER_SPECIFIC_ACCESS_DENIED_ERROR" });
  assert.deepEqual(calls[2].values, ["whatsapp"]);
  assert.deepEqual(calls[3].values, ["whatsapp"]);
  assert.doesNotMatch(JSON.stringify(result), /private|password|SELECT|trx_query/);
});
