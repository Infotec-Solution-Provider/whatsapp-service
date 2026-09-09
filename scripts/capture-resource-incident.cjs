#!/usr/bin/env node
"use strict";

// Read-only Linux collector. Never serialize PM2's raw response, environment,
// database URL, SQL text, or raw errors: these can contain credentials/content.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const net = require("node:net");
const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 3000;
const HELP = `Usage: node scripts/capture-resource-incident.cjs --pm2-id 13 [--samples 12] [--interval-ms 5000] [--db]
Linux only; run as the PM2 owner before restarting WhatsApp. Writes JSONL to stdout.
Reads PM2 and /proc; --db opens one extra MySQL connection for metadata SELECT/SHOW queries.
Database URL source: target PM2 environment, target cwd .env, then repository .env.
No credentials, SQL contents, raw errors, restarts, heap snapshots or file writes.
Queries/connect time out after 3 seconds each. Interval starts after each sample.
Missing privileges are reported as stage errors. sslmode=disable is supported (no TLS).
Other SSL/TLS options and socket URL options are not supported.
`;

function parseArgs(args) {
  const options = { pm2Id: null, samples: 12, intervalMs: 5000, db: false, help: false };
  const numeric = { "--pm2-id": ["pm2Id", 0, 1000000], "--samples": ["samples", 1, 120], "--interval-ms": ["intervalMs", 1000, 60000] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--db") options.db = true;
    else if (numeric[arg]) {
      const [key, minimum, maximum] = numeric[arg];
      const raw = args[++index];
      if (!/^\d+$/.test(raw || "")) throw new Error("invalid_arguments");
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("invalid_arguments");
      options[key] = value;
    } else throw new Error("invalid_arguments");
  }
  if (!options.help && options.pm2Id === null) throw new Error("missing_pm2_id");
  return options;
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function selectPm2(entry) {
  const env = entry.pm2_env || {};
  const axm = env.axm_monitor || {};
  const metrics = {};
  for (const [label, key] of Object.entries({
    "Used Heap Size": "heap_used_mib", "Heap Size": "heap_total_mib", "Heap Usage": "heap_used_percent",
    "Event Loop Latency": "event_loop_ms", "Event Loop Latency p95": "event_loop_p95_ms",
    "HTTP P95 Latency": "http_p95_ms", "HTTP Mean Latency": "http_mean_ms"
  })) metrics[key] = number(axm[label]?.value);
  return {
    pm2_id: number(entry.pm_id), pid: number(entry.pid), restart_count: number(env.restart_time),
    started_at_ms: number(env.pm_uptime), rss_bytes: number(entry.monit?.memory),
    cpu_percent: number(entry.monit?.cpu), ...metrics
  };
}

function parseProc(raw, fields) {
  const result = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z_]+):\s+(\d+)(?:\s+(kB))?\s*$/.exec(line);
    if (match && fields.includes(match[1])) result[match[1]] = Number(match[2]) * (match[3] ? 1024 : 1);
  }
  return result;
}

const ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ER_ACCESS_DENIED_ERROR", "ER_SPECIFIC_ACCESS_DENIED_ERROR", "ER_CON_COUNT_ERROR", "PROTOCOL_SEQUENCE_TIMEOUT", "PROTOCOL_CONNECTION_LOST"]);
const INTERNAL_ERRORS = new Set(["target_unavailable", "database_configuration_unavailable", "unsupported_database_configuration"]);
function safeError(error) {
  if (ERROR_CODES.has(error?.code)) return error.code;
  return INTERNAL_ERRORS.has(error?.message) ? error.message : "capture_failed";
}

async function getPm2Target(id) {
  const pm2Home = process.env.PM2_HOME || path.join(require("node:os").homedir(), ".pm2");
  // Do not let `pm2 jlist` start a new daemon when PM2 is not running.
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(pm2Home, "rpc.sock"));
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", (error) => { socket.destroy(); reject(error); });
    socket.once("timeout", () => { socket.destroy(); reject({ code: "ETIMEDOUT" }); });
  });
  const { stdout } = await execFileAsync("pm2", ["jlist"], { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  const entries = JSON.parse(stdout);
  const target = Array.isArray(entries) && entries.find((entry) => entry.pm_id === id);
  if (!target || !Number.isSafeInteger(target.pid) || target.pid < 1) throw new Error("target_unavailable");
  return target;
}

async function resolveDatabaseUrl(target) {
  const env = target.pm2_env || {};
  for (const value of [env.WHATSAPP_DATABASE_URL, env.env?.WHATSAPP_DATABASE_URL]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  const candidates = [env.pm_cwd && path.join(env.pm_cwd, ".env"), path.resolve(__dirname, "..", ".env")].filter(Boolean);
  for (const file of [...new Set(candidates)]) {
    try {
      const value = require("dotenv").parse(await fs.readFile(file)).WHATSAPP_DATABASE_URL;
      if (value) return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("database_configuration_unavailable");
}

function databaseConfig(rawUrl) {
  const url = new URL(rawUrl);
  const unsupportedOption = [...url.searchParams.entries()].some(([key, value]) => {
    if (key === "sslmode" && value === "disable" && url.searchParams.getAll(key).length === 1) return false;
    return /^(ssl|tls)/i.test(key) || /^socket(?:Path)?$/i.test(key);
  });
  if (url.protocol !== "mysql:" || unsupportedOption) {
    throw new Error("unsupported_database_configuration");
  }
  return {
    host: url.hostname.replace(/^\[([^\]]+)\]$/, "$1"), port: Number(url.port || 3306), user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)),
    connectTimeout: TIMEOUT_MS, enableKeepAlive: true, multipleStatements: false, ssl: false
  };
}

async function query(connection, sql, values = []) {
  const [rows] = await connection.query({ sql, values, timeout: TIMEOUT_MS });
  return rows;
}

async function captureDatabase(connection, user) {
  const metadata = await query(connection, "SELECT @@hostname AS hostname, @@port AS port, @@version AS version, DATABASE() AS database_name, CONNECTION_ID() AS collector_connection_id, @@max_connections AS max_connections, UNIX_TIMESTAMP(NOW(6)) AS server_unix_seconds");
  const status = await query(connection, "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Max_used_connections','Connections','Aborted_connects','Uptime')");
  const processes = await query(connection, "SELECT ID AS id, USER AS user, HOST AS host, DB AS database_name, COMMAND AS command, TIME AS seconds, STATE AS state FROM information_schema.PROCESSLIST WHERE USER = ? AND ID <> CONNECTION_ID() ORDER BY TIME DESC LIMIT 200", [user]);
  let transactions;
  try {
    transactions = await query(connection, "SELECT t.trx_id, t.trx_state, t.trx_started, t.trx_mysql_thread_id, t.trx_tables_locked, t.trx_rows_locked, t.trx_rows_modified FROM information_schema.innodb_trx t JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id WHERE p.USER = ? ORDER BY t.trx_started LIMIT 200", [user]);
  } catch (error) {
    transactions = { error: safeError(error) };
  }
  return {
    identity: metadata[0], status: Object.fromEntries(status.map((row) => [row.Variable_name, number(row.Value)])),
    processes, transactions, process_limit: 200, transaction_limit: 200,
    visibility: "metadata visible to the configured MySQL account; one additional collector connection"
  };
}

async function captureProc(pid) {
  const captures = {};
  for (const [key, file, fields] of [
    ["status", `/proc/${pid}/status`, ["VmRSS", "VmHWM", "VmSize", "RssAnon", "RssFile", "RssShmem", "VmSwap", "Threads"]],
    ["smaps_rollup", `/proc/${pid}/smaps_rollup`, ["Rss", "Pss", "Pss_Anon", "Pss_File", "Pss_Shmem", "Shared_Clean", "Shared_Dirty", "Private_Clean", "Private_Dirty", "Anonymous", "Swap", "SwapPss"]],
    ["host_memory", "/proc/meminfo", ["MemTotal", "MemAvailable", "SwapTotal", "SwapFree", "Dirty", "Writeback"]]
  ]) {
    try { captures[key] = parseProc(await fs.readFile(file, "utf8"), fields); }
    catch (error) { captures[key] = { error: safeError(error) }; }
  }
  return { byte_units_except_threads: true, ...captures };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch { process.stderr.write("Invalid arguments. Use --help.\n"); process.exitCode = 1; return; }
  if (options.help) { process.stdout.write(HELP); return; }
  if (process.platform !== "linux") {
    process.stdout.write(JSON.stringify({ type: "error", error: "linux_required" }) + "\n");
    process.exitCode = 1;
    return;
  }
  let connection = null;
  let dbUser;
  let dbPid;
  let dbAttempted = false;
  let databaseError = null;
  try {
    for (let index = 0; index < options.samples; index++) {
      const sample = { type: "sample", schema_version: 1, host: require("node:os").hostname(), sampled_at: new Date().toISOString(), sample: index + 1 };
      try {
        const target = await getPm2Target(options.pm2Id);
        sample.pm2 = selectPm2(target);
        sample.proc = await captureProc(target.pid);
        if (options.db && !dbAttempted) {
          dbAttempted = true;
          try {
            const config = databaseConfig(await resolveDatabaseUrl(target));
            dbUser = config.user;
            dbPid = target.pid;
            connection = await require("mysql2/promise").createConnection(config);
          } catch (error) { databaseError = { stage: "database_connect", error: safeError(error) }; }
        }
        if (connection && dbPid !== target.pid) {
          connection.destroy(); connection = null;
          databaseError = { error: "target_restarted_rerun_collector" };
        }
        if (connection) {
          try { sample.database = await captureDatabase(connection, dbUser); }
          catch (error) {
            databaseError = { stage: "database_query", error: safeError(error) };
            connection.destroy(); connection = null;
          }
        }
        if (options.db && !sample.database) sample.database = databaseError;
      } catch (error) { sample.error = { stage: "pm2", code: safeError(error) }; }
      sample.completed_at = new Date().toISOString();
      process.stdout.write(JSON.stringify(sample) + "\n");
      if (index + 1 < options.samples) await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  } finally { if (connection) connection.destroy(); }
}

module.exports = { parseArgs, selectPm2, parseProc, safeError, databaseConfig, captureDatabase };
if (require.main === module) void main().catch(() => {
  process.stdout.write(JSON.stringify({ type: "error", error: "capture_failed" }) + "\n");
  process.exitCode = 1;
});
