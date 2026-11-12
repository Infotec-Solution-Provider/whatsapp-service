import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { PrismaClient } from "@prisma/client";
import { assertWabaReactionOperationsSchema, WABA_REACTION_SCHEMA_SQL } from "../services/waba-reaction-schema";

/** Explicit, single-table migration. Never invokes the pending Prisma migration chain. */
export async function migrateWabaReactions(
  db: Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">,
  environment: "production" | "homolog", mode: "check" | "apply", sql: string, expectedSha: string,
) {
  if (!["production", "homolog"].includes(environment) || !["check", "apply"].includes(mode)) throw Error("WABA_REACTION_MIGRATION_ARGUMENT_REJECTED");
  const sha = createHash("sha256").update(sql).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedSha) || sha !== expectedSha) throw Error("WABA_REACTION_MIGRATION_HASH_MISMATCH");
  const statement = sql.replace(/^\s*--[^\n]*$/gm, "").trim();
  if (!/^CREATE TABLE IF NOT EXISTS `waba_reaction_operations`\s*\([\s\S]*\) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;$/u.test(statement) || statement.split(";").length !== 2) throw Error("WABA_REACTION_MIGRATION_STATEMENT_REJECTED");
  const expectedDatabase = environment === "production" ? "inpulse-whatsapp" : "homolog-whatsapp";
  const identity = await db.$queryRawUnsafe<Array<{ databaseName: string }>>("SELECT DATABASE() AS databaseName");
  if (identity.length !== 1 || identity[0]?.databaseName !== expectedDatabase) throw Error("WABA_REACTION_MIGRATION_DATABASE_MISMATCH");
  let rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(WABA_REACTION_SCHEMA_SQL);
  let created = false;
  if (rows.length === 0) {
    if (mode === "check") return { environment, database: expectedDatabase, state: "MIGRATION_REQUIRED", sqlSha256: sha, created: false };
    await db.$executeRawUnsafe(statement);
    created = true;
    rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(WABA_REACTION_SCHEMA_SQL);
  }
  assertWabaReactionOperationsSchema(rows);
  return { environment, database: expectedDatabase, state: "SCHEMA_VERIFIED", sqlSha256: sha, created };
}

async function main() {
  const [environment, mode, sqlFile, expectedSha, ...extra] = process.argv.slice(2);
  if ((environment !== "production" && environment !== "homolog") || (mode !== "check" && mode !== "apply") || !sqlFile || !expectedSha || extra.length) throw Error("WABA_REACTION_MIGRATION_USAGE_ENV_MODE_SQL_SHA");
  if (hostname() !== "srv733293" || process.getuid?.() !== 1003) throw Error("WABA_REACTION_MIGRATION_HOST_OWNER_REQUIRED");
  if (!process.env["WHATSAPP_DATABASE_URL"]) throw Error("WABA_REACTION_MIGRATION_APP_CONFIGURATION_REQUIRED");
  const db = new PrismaClient({ log: [] });
  try {
    const result = await migrateWabaReactions(db, environment, mode, readFileSync(sqlFile, "utf8"), expectedSha);
    console.log(JSON.stringify(result));
  } finally { await db.$disconnect(); }
}

if (require.main === module) void main().catch(error => {
  const detail = error instanceof Error && /^WABA_REACTION_[A-Z_]+(?::[a-z_]+)?$/.test(error.message)
    ? error.message : "WABA_REACTION_MIGRATION_FAILED";
  console.error(JSON.stringify({ error: detail }));
  process.exitCode = 1;
});
