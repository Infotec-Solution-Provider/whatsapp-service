import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { sql } from "../database/managed-mysql";

/** Metadata only. Never reads message/contact payloads or modifies existing wpp_* tables. */
export async function inspectWppSchema(connection: PoolConnection, timeoutMs = 3000, onQuery?: (query: string) => void) {
	const metadata = (name: string, statement: string) => {
		onQuery?.(name);
		return sql<RowDataPacket[]>(connection, statement, [], timeoutMs);
	};
	// LEFT avoids interpreting the underscore in wpp_ as a LIKE wildcard.
	const tables = await metadata("schema-tables", `SELECT TABLE_NAME AS name,
		TABLE_TYPE AS type, ENGINE AS engine, ROW_FORMAT AS row_format, TABLE_COLLATION AS collation,
		TABLE_ROWS AS estimated_rows, DATA_LENGTH AS data_bytes, INDEX_LENGTH AS index_bytes,
		AUTO_INCREMENT AS next_id
		FROM information_schema.TABLES
		WHERE TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, 4) = 'wpp_' ORDER BY TABLE_NAME`);
	// MySQL 5.5 has no DATETIME_PRECISION column. COLUMN_TYPE also reports precision on newer servers.
	const columns = await metadata("schema-columns", `SELECT TABLE_NAME AS table_name,
		ORDINAL_POSITION AS position, COLUMN_NAME AS name, COLUMN_TYPE AS type,
		IS_NULLABLE AS nullable, COLUMN_DEFAULT IS NOT NULL AS has_default,
		CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, EXTRA AS extra
		FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, 4) = 'wpp_'
		ORDER BY TABLE_NAME, ORDINAL_POSITION`);
	const indexes = await metadata("schema-indexes", `SELECT TABLE_NAME AS table_name,
		INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS position,
		COLUMN_NAME AS column_name, SUB_PART AS prefix_length, INDEX_TYPE AS type
		FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, 4) = 'wpp_'
		ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`);
	const references = await metadata("schema-references", `SELECT TABLE_SCHEMA AS source_schema,
		TABLE_NAME AS table_name, CONSTRAINT_NAME AS name, COLUMN_NAME AS column_name,
		REFERENCED_TABLE_SCHEMA AS target_schema, REFERENCED_TABLE_NAME AS target_table,
		REFERENCED_COLUMN_NAME AS target_column
		FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL
		AND ((TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, 4) = 'wpp_')
		OR (REFERENCED_TABLE_SCHEMA = DATABASE() AND LEFT(REFERENCED_TABLE_NAME, 4) = 'wpp_'))
		ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`);
	const triggers = await metadata("schema-triggers", `SELECT TRIGGER_NAME AS name,
		EVENT_OBJECT_TABLE AS table_name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
		FROM information_schema.TRIGGERS
		WHERE TRIGGER_SCHEMA = DATABASE() AND LEFT(EVENT_OBJECT_TABLE, 4) = 'wpp_'
		ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`);
	return { tables, columns, indexes, references, triggers,
		metadataVisibility: "Limited to objects visible to this database user; empty results do not prove absence of privileged objects." };
}
