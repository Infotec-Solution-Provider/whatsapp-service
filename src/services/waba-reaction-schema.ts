/** Read-only, database-scoped metadata query for reviewed migration preflight. */
export const WABA_REACTION_SCHEMA_SQL = `SELECT 'table' AS kind,TABLE_NAME AS name,TABLE_COLLATION AS definition,NULL AS nullable,ENGINE AS extra,NULL AS defaultValue,NULL AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waba_reaction_operations'
UNION ALL SELECT 'column',COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA,CAST(COLUMN_DEFAULT AS CHAR),COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waba_reaction_operations'
UNION ALL SELECT 'index',INDEX_NAME,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ','),CAST(MIN(NON_UNIQUE) AS CHAR),NULL,NULL,NULL FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waba_reaction_operations' GROUP BY INDEX_NAME
UNION ALL SELECT 'check',tc.CONSTRAINT_NAME,cc.CHECK_CLAUSE,NULL,NULL,NULL,NULL FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME='waba_reaction_operations' AND tc.CONSTRAINT_TYPE='CHECK'`;

const columns: Record<string, [string, string]> = {
  id: ["char(36)", "NO"], sequence: ["bigint unsigned", "NO"], instance: ["varchar(191)", "NO"], client_id: ["int", "NO"],
  target_message_id: ["varchar(191)", "NO"], recipient_id: ["varchar(32)", "NO"], emoji: ["varchar(64)", "NO"],
  provider_message_id: ["varchar(191)", "YES"], status: ["varchar(16)", "NO"], status_at: ["datetime(3)", "YES"],
  error_code: ["varchar(64)", "YES"], baseline_reaction_json: ["longtext", "YES"], internal_user_id: ["int", "YES"],
  internal_user_name: ["varchar(191)", "YES"], created_at: ["datetime(3)", "NO"], accepted_at: ["datetime(3)", "YES"], updated_at: ["datetime(3)", "NO"],
};
const indexes: Record<string, [string, string]> = {
  PRIMARY: ["id", "0"], waba_reaction_operation_sequence: ["sequence", "0"],
  waba_reaction_operation_scope_provider: ["instance,client_id,provider_message_id", "0"],
  waba_reaction_operation_target: ["instance,client_id,target_message_id,created_at", "1"],
};
export function assertWabaReactionOperationsSchema(rows: Record<string, unknown>[]): void {
  const table = rows.filter(row => row["kind"] === "table");
  if (table.length !== 1 || table[0]?.["definition"] !== "utf8mb4_bin" || table[0]?.["extra"] !== "InnoDB") throw Error("WABA_REACTION_SCHEMA_TABLE_MISMATCH");
  for (const [kind, expected] of [["column", columns], ["index", indexes]] as const) {
    const selected = rows.filter(row => row["kind"] === kind);
    if (selected.length !== Object.keys(expected).length) throw Error("WABA_REACTION_SCHEMA_" + kind.toUpperCase() + "_COUNT");
    for (const [name, [definition, nullable]] of Object.entries(expected)) {
      const row = selected.find(row => row["name"] === name);
      if (!row || String(row["definition"]).toLowerCase() !== definition || String(row["nullable"]) !== nullable) throw Error("WABA_REACTION_SCHEMA_MISMATCH:" + name);
      if (name === "sequence" && row["extra"] !== "auto_increment") throw Error("WABA_REACTION_SCHEMA_SEQUENCE_REQUIRED");
      if (kind === "column") {
        const wantedDefault = name === "created_at" || name === "updated_at" ? "current_timestamp(3)" : null;
        if ((row["defaultValue"] == null ? null : String(row["defaultValue"]).toLowerCase()) !== wantedDefault ||
            (/(?:char|text)/.test(definition) ? row["collation"] !== "utf8mb4_bin" : row["collation"] !== null)) throw Error("WABA_REACTION_SCHEMA_DEFAULT_OR_COLLATION:" + name);
      }
    }
  }
  const checks = rows.filter(row => row["kind"] === "check");
  if (checks.length !== 2 || !checks.some(row => row["name"] === "waba_reaction_operation_baseline_json" && /json_valid/i.test(String(row["definition"]))) ||
      !checks.some(row => row["name"] === "waba_reaction_operation_status" && ["PREPARED", "ACCEPTED", "UNKNOWN", "REJECTED", "SENT", "DELIVERED", "READ", "FAILED"].every(value => String(row["definition"]).includes(value)))) throw Error("WABA_REACTION_SCHEMA_CHECK_MISMATCH");
}
