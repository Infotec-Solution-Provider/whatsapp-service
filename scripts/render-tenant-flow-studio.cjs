// Render the additive DDL for an already prepared tenant-SQL runtime.
// This script writes only to stdout. Existing runtime data stays in place.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ddl = readFileSync(join(__dirname, "../prisma/migrations/20261125160000_message_flow_studio/migration.sql"), "utf8");
process.stdout.write(ddl.replace(/CREATE TABLE `(message_flow_library|message_flow_publications)`/g, "CREATE TABLE `wpp_runtime_$1`"));
