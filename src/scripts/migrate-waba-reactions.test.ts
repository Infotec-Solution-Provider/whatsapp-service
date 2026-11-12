import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrateWabaReactions } from "./migrate-waba-reactions";

async function main() {
  const sql = readFileSync(resolve("prisma/migrations/20261112190000_waba_reaction_operations/migration.sql"), "utf8");
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const calls: string[] = [];
  let databaseName = "inpulse-whatsapp";
  let schema: Record<string, unknown>[] = [];
  const db = {
    async $queryRawUnsafe(query: string) { calls.push(query); return query.startsWith("SELECT DATABASE()") ? [{ databaseName }] : schema; },
    async $executeRawUnsafe(query: string) { calls.push(query); return 0; },
  } as unknown as Parameters<typeof migrateWabaReactions>[0];
  const ddlCalls = () => calls.filter(call => call.startsWith("CREATE TABLE"));

  await assert.rejects(migrateWabaReactions(db, "production", "apply", sql, "0".repeat(64)), /HASH_MISMATCH/);
  assert.equal(calls.length, 0);
  const unexpected = "DROP TABLE waba_reaction_operations;";
  await assert.rejects(migrateWabaReactions(db, "production", "apply", unexpected, sha(unexpected)), /STATEMENT_REJECTED/);
  assert.equal(calls.length, 0);
  databaseName = "homolog-whatsapp";
  await assert.rejects(migrateWabaReactions(db, "production", "apply", sql, sha(sql)), /DATABASE_MISMATCH/);
  assert.equal(ddlCalls().length, 0);
  calls.length = 0;
  databaseName = "inpulse-whatsapp";
  const absent = await migrateWabaReactions(db, "production", "check", sql, sha(sql));
  assert.equal(absent.state, "MIGRATION_REQUIRED");
  assert.equal(ddlCalls().length, 0);
  schema = [{ kind: "table", definition: "wrong_collation" }];
  await assert.rejects(migrateWabaReactions(db, "production", "apply", sql, sha(sql)), /SCHEMA_TABLE_MISMATCH/);
  assert.equal(ddlCalls().length, 0);
  schema = [];
  await assert.rejects(migrateWabaReactions(db, "production", "apply", sql, sha(sql)), /SCHEMA_TABLE_MISMATCH/);
  assert.equal(ddlCalls().length, 1);
  assert.equal(calls.filter(call => /^(?:UPDATE|DELETE|ALTER|DROP|INSERT)/i.test(call)).length, 0);
  console.log("migrate-waba-reactions: hash, statement, database, read-only check, drift refusal and single additive DDL guards passed");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
