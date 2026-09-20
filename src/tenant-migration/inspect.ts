import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { databaseIdentity, sql } from "../database/managed-mysql";

export async function inspectTenantDatabase(connection: PoolConnection) {
	const identity = await databaseIdentity(connection);
	const charsets = await sql<RowDataPacket[]>(connection, "SHOW CHARACTER SET LIKE 'utf8mb4'");
	const collations = await sql<RowDataPacket[]>(connection, "SHOW COLLATION WHERE Collation IN ('utf8mb4_unicode_ci', 'utf8mb4_bin')");
	const variables = await sql<RowDataPacket[]>(connection, `SHOW VARIABLES WHERE Variable_name IN (
		'character_set_server', 'character_set_database', 'character_set_client', 'character_set_connection',
		'character_set_results', 'collation_connection', 'collation_database', 'sql_mode',
		'innodb_file_format', 'innodb_large_prefix', 'max_allowed_packet')`);
	const tables = await sql<RowDataPacket[]>(connection, `SELECT TABLE_NAME AS name, ENGINE AS engine, ROW_FORMAT AS row_format,
		TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN
		('wpp_messages', 'wpp_last_messages', 'wpp_contacts', 'wpp_chats') ORDER BY TABLE_NAME`);
	const settings = Object.fromEntries(variables.map(row => [String(row["Variable_name"]), String(row["Value"])]));
	return {
		identity, utf8mb4: charsets.length > 0, collations: collations.map(row => String(row["Collation"])), settings, tables,
		eligibleForNativeTextProbe: charsets.length > 0 && collations.some(row => row["Collation"] === "utf8mb4_unicode_ci"),
		readyForCutover: false,
		remaining: ["persistent round-trip test", "domain schema and index validation", "runtime repository routing", "capture of concurrent changes", "data copy and reconciliation"],
	};
}

/** Opt-in test on a connection-private temporary table; never touches ERP tables. */
export async function probeTenantText(connection: PoolConnection): Promise<void> {
	const samples = [null, "", "Ação São João ç €", "👩🏽‍💻 😀", "日本語 中文", "literal %20 %25", "https://example.test/a%20b", "line\nquote'\"\\", "e\u0301", JSON.stringify({ emoji: "😀", empty: "", nil: null })];
	await sql(connection, "CREATE TEMPORARY TABLE inpulse_migration_text_probe (id INT PRIMARY KEY, value LONGTEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
	try {
		for (let i = 0; i < samples.length; i++) await sql(connection, "INSERT INTO inpulse_migration_text_probe (id, value) VALUES (?, ?)", [i, samples[i]]);
		const rows = await sql<RowDataPacket[]>(connection, "SELECT id, value, HEX(value) AS hex_value FROM inpulse_migration_text_probe ORDER BY id");
		if (rows.length !== samples.length || rows.some((row, index) => row["value"] !== samples[index] || row["hex_value"] !== (samples[index] === null ? null : Buffer.from(samples[index]!, "utf8").toString("hex").toUpperCase()))) throw new Error("Tenant Unicode round-trip mismatch");
	} finally { await sql(connection, "DROP TEMPORARY TABLE IF EXISTS inpulse_migration_text_probe"); }
}
