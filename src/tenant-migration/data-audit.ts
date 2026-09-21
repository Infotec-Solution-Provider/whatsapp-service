import { DataAccess, rowKey, statementBytes } from "./data-access";
import { DataRow, Entity, TenantDataError } from "./data-contract";
import { WppSchema } from "./prepare-plan";

const table = "wpp_tenant_copy_audit";
const types: Record<string, string> = { run_id: "varchar(64)", entity: "varchar(32)", row_key: "varchar(64)", part: "int(11)", parts: "int(11)", binding_hash: "char(64)", payload: "longtext", created_at: "datetime" };
const primary = ["run_id", "entity", "row_key", "part"];
const textType = (type: string) => /char|text/.test(type);
export const auditSql = `CREATE TABLE ${table} (${Object.entries(types).map(([name, type]) => `\`${name}\` ${type}${textType(type) ? " CHARACTER SET ascii COLLATE ascii_bin" : ""} NOT NULL`).join(",")}, PRIMARY KEY (${primary.map(k => `\`${k}\``).join(",")})) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`;

export function checkDataAudit(schema: WppSchema): boolean {
	const info = schema.tables.find(t => t["name"] === table); if (!info) return false;
	const columns = schema.columns.filter(c => c["table_name"] === table), indexes = schema.indexes.filter(i => i["table_name"] === table);
	if (info["engine"] !== "InnoDB" || info["type"] !== "BASE TABLE" || columns.length !== Object.keys(types).length
		|| !Object.entries(types).every(([name, type]) => columns.some(c => c["name"] === name && c["type"] === type && c["nullable"] === "NO" && c["extra"] === "" && (!textType(type) || c["collation"] === "ascii_bin")))
		|| indexes.length !== primary.length || !primary.every((name, n) => indexes.some(i => i["name"] === "PRIMARY" && Number(i["position"]) === n + 1 && i["column_name"] === name && i["prefix_length"] === null && Number(i["non_unique"]) === 0))
		|| schema.triggers.some(t => t["table_name"] === table) || schema.references.some(r => r["table_name"] === table || r["target_table"] === table))
		throw new TenantDataError("TENANT_COPY_AUDIT_SCHEMA_CONFLICT");
	return true;
}

export interface AuditedUpdate { row: DataRow; before: DataRow; columns: string[] }

/** Same transaction as changes and checkpoint; plain INSERT never replaces earlier evidence. */
export async function auditUpdates(target: DataAccess, entity: Entity, updates: AuditedUpdate[], runId: string, binding: string, budget: number) {
	const chunkSize = Math.min(131072, Math.floor(budget / 2));
	for (const update of updates) {
		// Base64 keeps exact stored strings (including literal escapes) representable on old MySQL.
		const payload = Buffer.from(JSON.stringify({ version: 1, columns: update.columns, before: update.before,
			after: Object.fromEntries(update.columns.map(column => [column, update.row[column]])) }), "utf8").toString("base64");
		const parts = Math.ceil(payload.length / chunkSize);
		for (let part = 0; part < parts; part++) {
			const statement = `INSERT INTO ${table} (run_id,entity,row_key,part,parts,binding_hash,payload,created_at) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP())`;
			const values = [runId, entity, rowKey(entity, update.row), part, parts, binding, payload.slice(part * chunkSize, (part + 1) * chunkSize)];
			if (statementBytes(statement, values) > budget) throw new TenantDataError("TENANT_STATEMENT_EXCEEDS_PACKET_BUDGET", { entity, budget });
			await target.query("audit-update", statement, values);
		}
	}
}
