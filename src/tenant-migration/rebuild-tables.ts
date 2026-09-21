import { DataAccess } from "./data-access";
import { DataRow, Entity, tables, TenantDataError } from "./data-contract";
import { legacyContract } from "./legacy-contract";
import { quote } from "./prepare-contract";
import { WppSchema } from "./prepare-plan";

export const lastFields = ["instance", "contact_id", "chat_id", "message_id", "from", "to", "type", "body", "timestamp", "sent_at", "status", "file_id", "file_name", "file_type", "file_size", "user_id", "billing_category", "client_id"];
export const rebuildTables = [...Object.values(tables), "wpp_last_messages"];
export function rebuildNames(token: string) {
	if (!/^[a-f0-9]{20}$/.test(token)) throw new TenantDataError("TENANT_REBUILD_NAMES_INVALID");
	return Object.fromEntries(rebuildTables.map(live => [live, { live, shadow: `wpp_rb_${token}_n_${live.slice(4)}`, old: `wpp_rb_${token}_o_${live.slice(4)}` }]));
}
export function checkRebuildTables(schema: WppSchema): void {
	for (const table of rebuildTables) {
		const info = schema.tables.find(t => t["name"] === table);
		if (info?.["type"] !== "BASE TABLE" || info["engine"] !== "InnoDB" || info["collation"] !== "utf8_general_ci"
			|| schema.triggers.some(t => t["table_name"] === table) || schema.references.some(r => r["table_name"] === table || r["target_table"] === table))
			throw new TenantDataError("TENANT_REBUILD_DEPENDENCY_CONFLICT", { table });
	}
	const columns = schema.columns.filter(c => c["table_name"] === "wpp_last_messages");
	for (const field of lastFields) {
		const expected = legacyContract.wpp_messages.columns.find(c => c.name === (field === "message_id" ? "id" : field))!;
		const actual = columns.find(c => c["name"] === field);
		if (!actual || actual["type"] !== expected.type || actual["charset"] !== expected.charset || actual["collation"] !== expected.collation
			|| actual["nullable"] !== (field === "contact_id" ? "NO" : expected.nullable))
			throw new TenantDataError("TENANT_REBUILD_PROJECTION_SCHEMA_INVALID", { column: field });
	}
	if (columns.some(c => !lastFields.includes(String(c["name"])) && c["nullable"] === "NO" && !Number(c["has_default"]) && c["extra"] !== "auto_increment"))
		throw new TenantDataError("TENANT_REBUILD_PROJECTION_SCHEMA_INVALID");
}

export function checkSyncState(schema: WppSchema): boolean {
	const table = "wpp_sync_state", info = schema.tables.find(t => t["name"] === table);
	if (!info) return false;
	const columns = schema.columns.filter(c => c["table_name"] === table);
	const primary = schema.indexes.filter(i => i["table_name"] === table && i["name"] === "PRIMARY");
	if (info["type"] !== "BASE TABLE" || info["engine"] !== "InnoDB"
		|| !columns.some(c => c["name"] === "entity" && /^varchar\(/.test(String(c["type"])))
		|| !columns.some(c => c["name"] === "last_synced_id" && c["type"] === "int(11)")
		|| primary.length !== 1 || primary[0]?.["column_name"] !== "entity" || primary[0]?.["prefix_length"] !== null
		|| columns.some(c => !["entity", "last_synced_id"].includes(String(c["name"])) && c["nullable"] === "NO" && !Number(c["has_default"]) && c["extra"] !== "auto_increment")
		|| schema.triggers.some(t => t["table_name"] === table) || schema.references.some(r => r["table_name"] === table || r["target_table"] === table))
		throw new TenantDataError("TENANT_REBUILD_DEPENDENCY_CONFLICT", { table });
	return true;
}

export async function tableMarkers(target: DataAccess, names: string[]): Promise<Record<string, string>> {
	const rows = await target.query<DataRow[]>("rebuild-tables", `SELECT TABLE_NAME AS name,TABLE_COMMENT AS marker FROM information_schema.TABLES
		WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(() => "?").join(",")})`, names);
	return Object.fromEntries(rows.map(row => [String(row["name"]), String(row["marker"])]));
}

export async function rebuildProjection(target: DataAccess, names: ReturnType<typeof rebuildNames>): Promise<number> {
	const messages = quote(names["wpp_messages"]!.shadow), last = quote(names["wpp_last_messages"]!.shadow);
	await target.query("rebuild-projection-reset", `DELETE FROM ${last}`); // Private shadow only, inside the caller's transaction.
	await target.query("rebuild-projection", `INSERT INTO ${last} (${lastFields.map(quote).join(",")})
		SELECT ${lastFields.map(f => `m.${quote(f === "message_id" ? "id" : f)}`).join(",")} FROM ${messages} m
		JOIN (SELECT contact_id,MAX(id) AS last_id FROM ${messages} WHERE contact_id IS NOT NULL GROUP BY contact_id) latest ON latest.last_id=m.id`);
	const rows = await target.query<DataRow[]>("rebuild-projection-count", `SELECT (SELECT COUNT(*) FROM ${last}) AS actual,
		(SELECT COUNT(DISTINCT contact_id) FROM ${messages}) AS expected`);
	if (!rows[0] || String(rows[0]["actual"]) !== String(rows[0]["expected"])) throw new TenantDataError("TENANT_REBUILD_PROJECTION_MISMATCH");
	return Number(rows[0]["actual"]);
}

export function targetOverrides(names: ReturnType<typeof rebuildNames>): Partial<Record<Entity, string>> {
	return Object.fromEntries(Object.entries(tables).map(([entity, table]) => [entity, names[table]!.shadow]));
}
