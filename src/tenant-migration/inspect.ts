import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { databaseIdentity, sql } from "../database/managed-mysql";
import { inspectWppSchema } from "./inspect-wpp-schema";
import { decodeTenantText, encodeTenantText, TextProfile } from "./encoding";

export async function inspectTenantDatabase(connection: PoolConnection) {
	const identity = await databaseIdentity(connection);
	const charsets = await sql<RowDataPacket[]>(connection, "SHOW CHARACTER SET LIKE 'utf8mb4'");
	const collations = await sql<RowDataPacket[]>(connection, "SHOW COLLATION WHERE Collation IN ('utf8mb4_unicode_ci', 'utf8mb4_bin')");
	const variables = await sql<RowDataPacket[]>(connection, `SHOW VARIABLES WHERE Variable_name IN (
		'character_set_server', 'character_set_database', 'character_set_client', 'character_set_connection',
		'character_set_results', 'collation_connection', 'collation_database', 'sql_mode',
		'innodb_file_format', 'innodb_large_prefix', 'max_allowed_packet')`);
	const schema = await inspectWppSchema(connection);
	const settings = Object.fromEntries(variables.map(row => [String(row["Variable_name"]), String(row["Value"])]));
	return {
		identity, utf8mb4: charsets.length > 0, collations: collations.map(row => String(row["Collation"])), settings, tables: schema.tables,
		existingWppSchema: schema,
		eligibleForNativeTextProbe: charsets.length > 0 && collations.some(row => row["Collation"] === "utf8mb4_unicode_ci"),
		textProfileCandidates: charsets.length > 0 ? ["utf8mb4-native-v1", "percent-encoded-v1"] : ["percent-encoded-v1"],
		readyForCutover: false,
		remaining: ["persistent round-trip test", "domain schema and index validation", "runtime repository routing", "capture of concurrent changes", "data copy and reconciliation"],
	};
}

/** Opt-in test on a connection-private temporary table; never touches ERP tables. */
export async function probeTenantText(connection: PoolConnection, profile: TextProfile = "utf8mb4-native-v1"): Promise<void> {
	if (profile !== "utf8mb4-native-v1" && profile !== "percent-encoded-v1") throw new Error("Unknown text storage profile");
	const samples = [null, "", "Ação São João ç €", "👩🏽‍💻 😀", "日本語 中文", "literal %20 %25", "https://example.test/a%20b", "line\nquote'\"\\", "e\u0301", JSON.stringify({ emoji: "😀", empty: "", nil: null })];
	const stored = samples.map(value => encodeTenantText(value, profile));
	const charset = profile === "utf8mb4-native-v1" ? "utf8mb4 COLLATE=utf8mb4_unicode_ci" : "utf8 COLLATE=utf8_general_ci";
	await sql(connection, `CREATE TEMPORARY TABLE inpulse_migration_text_probe (id INT PRIMARY KEY, value LONGTEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=${charset}`);
	try {
		for (let i = 0; i < stored.length; i++) await sql(connection, "INSERT INTO inpulse_migration_text_probe (id, value) VALUES (?, ?)", [i, stored[i]]);
		const rows = await sql<RowDataPacket[]>(connection, "SELECT id, value, HEX(value) AS hex_value FROM inpulse_migration_text_probe ORDER BY id");
		if (rows.length !== samples.length || rows.some((row, index) =>
			row["value"] !== stored[index] || decodeTenantText(row["value"], profile) !== samples[index] ||
			row["hex_value"] !== (stored[index] === null ? null : Buffer.from(stored[index]!, "utf8").toString("hex").toUpperCase()))) throw new Error("Tenant Unicode round-trip mismatch");
	} finally { await sql(connection, "DROP TEMPORARY TABLE IF EXISTS inpulse_migration_text_probe"); }
}
