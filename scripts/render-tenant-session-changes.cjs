const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const [instance, ...extra] = process.argv.slice(2);
if (!instance || !/^[a-z][a-z0-9-]{0,62}$/.test(instance) || extra.length) {
  process.stderr.write("Usage: node scripts/render-tenant-session-changes.cjs <tenant>\n");
  process.exit(1);
}

const migration = readFileSync(resolve(
  __dirname,
  "../prisma/migrations/20261022120000_session_changes/migration.sql",
), "utf8").replace(/\r\n/g, "\n");

const parts = migration.split(/^CREATE TRIGGER /m);
const [tables, ...triggers] = parts;
if (triggers.length !== 9) {
  throw new Error("Expected nine triggers in the canonical session changes migration");
}

const tenantTableNames = /\b(?:session_change_streams|session_changes|chat_user_preferences|messages|chats)\b/g;
const toTenantTables = (sql) => {
  return sql.replace(tenantTableNames, (name) => `wpp_runtime_${name}`);
};

// A tenant has its own database. Seed only its stream, including tenants without channels.
const createTables = toTenantTables(tables.slice(tables.indexOf("CREATE TABLE "), tables.indexOf("INSERT INTO ")))
  .replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ");
const createTriggers = triggers.map((definition) => {
  const body = toTenantTables(definition.trim())
    // Match the journal collation even when a writer table inherited a different default.
    .replace(/WHERE instance = ((?:NEW|OLD)\.instance);/g, "WHERE instance = CONVERT($1 USING utf8mb4) COLLATE utf8mb4_unicode_ci;")
    .replace(/;$/, "");
  return `CREATE TRIGGER IF NOT EXISTS wpp_runtime_${body}$$\n`;
});

process.stdout.write([
  "SET SESSION lock_wait_timeout = 5;\n",
  "SET SESSION innodb_lock_wait_timeout = 5;\n",
  createTables,
  "DELIMITER $$\n",
  ...createTriggers,
  "DELIMITER ;\n",
  "INSERT IGNORE INTO wpp_runtime_session_change_streams (instance, epoch)\n",
  `VALUES ('${instance}', UUID());\n`,
].join(""));
