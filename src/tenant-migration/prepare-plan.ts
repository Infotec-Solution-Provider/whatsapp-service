import { inspectWppSchema } from "./inspect-wpp-schema";
import { legacyContract } from "./legacy-contract";
import { additions, columnDefinition, journalColumns, journalTable, modifications, quote } from "./prepare-contract";

export type WppSchema = Awaited<ReturnType<typeof inspectWppSchema>>;
export type PrepareBlocker = { code: string; table: string; column?: string };
export type PrepareStep = { id: string; table: string; sql: string };

export function buildPreparePlan(schema: WppSchema) {
	const blockers: PrepareBlocker[] = [];
	const steps: PrepareStep[] = [];
	for (const [table, contract] of Object.entries(legacyContract)) {
		const info = schema.tables.find(row => row["name"] === table);
		if (!info || info["type"] !== "BASE TABLE" || info["engine"] !== "InnoDB" || info["collation"] !== "utf8_general_ci") {
			blockers.push({ code: "LEGACY_TABLE_INCOMPATIBLE", table }); continue;
		}
		const columns = schema.columns.filter(row => row["table_name"] === table);
		const changes: string[] = [];
		for (const expected of contract.columns) {
			const actual = columns.find(row => row["name"] === expected.name);
			const finalName = table === "wpp_contacts" && expected.name === "name" && actual?.["type"] === "longtext";
			const finalPhone = table === "wpp_contacts" && expected.name === "phone" && actual?.["nullable"] === "YES";
			if (!actual || (!finalName && actual["type"] !== expected.type) || (!finalPhone && actual["nullable"] !== expected.nullable)
				|| actual["charset"] !== expected.charset || actual["collation"] !== expected.collation || actual["extra"] !== expected.extra) {
				blockers.push({ code: "LEGACY_COLUMN_INCOMPATIBLE", table, column: expected.name }); continue;
			}
			if (table === "wpp_contacts" && ["name", "phone"].includes(expected.name) && Number(actual["has_default"]) !== 0) {
				blockers.push({ code: "LEGACY_DEFAULT_REQUIRES_REVIEW", table, column: expected.name }); continue;
			}
			if (table === "wpp_contacts" && expected.name === "name" && !finalName) changes.push(`MODIFY COLUMN ${modifications.name}`);
			if (table === "wpp_contacts" && expected.name === "phone" && !finalPhone) changes.push(`MODIFY COLUMN ${modifications.phone}`);
		}
		const indexRows = schema.indexes.filter(row => row["table_name"] === table);
		if (table === "wpp_contacts" && indexRows.some(row => row["column_name"] === "name")) {
			blockers.push({ code: "CONTACT_NAME_INDEX_REQUIRES_REVIEW", table, column: "name" });
		}
		for (const index of contract.uniqueIndexes) {
			const matches = [...new Set(indexRows.map(row => row["name"]))].some(name => {
				const parts = indexRows.filter(row => row["name"] === name).sort((a, b) => Number(a["position"]) - Number(b["position"]));
				return (index.primary ? name === "PRIMARY" : true) && parts.length === index.columns.length
					&& parts.every((part, i) => Number(part["non_unique"]) === 0 && part["prefix_length"] === null && part["column_name"] === index.columns[i]);
			});
			if (!matches) blockers.push({ code: "LEGACY_UNIQUE_INDEX_INCOMPATIBLE", table });
		}
		for (const [name, type] of Object.entries(additions[table] ?? {})) {
			const actual = columns.find(row => row["name"] === name);
			if (!actual) changes.push(`ADD COLUMN ${columnDefinition(name, type)}`);
			else if (actual["type"] !== type || actual["nullable"] !== "YES" || actual["extra"] !== "" || Number(actual["has_default"]) !== 0
				|| (/char|text/.test(type) && (actual["charset"] !== "utf8" || actual["collation"] !== "utf8_general_ci"))) {
				blockers.push({ code: "PREPARE_COLUMN_INCOMPATIBLE", table, column: name });
			}
		}
		// An unknown required column could make the future explicit-column INSERT impossible.
		for (const column of columns) {
			const name = String(column["name"]);
			if (!contract.columns.some(item => item.name === name) && !Object.hasOwn(additions[table] ?? {}, name)
				&& column["nullable"] === "NO" && Number(column["has_default"]) === 0 && column["extra"] !== "auto_increment") {
				blockers.push({ code: "UNKNOWN_REQUIRED_COLUMN", table });
			}
		}
		if (changes.length) steps.push({ id: table, table, sql: `ALTER TABLE ${quote(table)}\n  ${changes.join(",\n  ")}` });
	}
	// External dependencies need a reviewed migration, not an automatically guessed rewrite.
	for (const table of Object.keys(legacyContract)) {
		if (schema.triggers.some(row => row["table_name"] === table)) blockers.push({ code: "VISIBLE_TRIGGER_REQUIRES_REVIEW", table });
		if (schema.references.some(row => row["table_name"] === table || row["target_table"] === table)) blockers.push({ code: "VISIBLE_FOREIGN_KEY_REQUIRES_REVIEW", table });
	}
	const journal = schema.tables.find(row => row["name"] === journalTable);
	if (journal) {
		const columns = schema.columns.filter(row => row["table_name"] === journalTable);
		const indexes = schema.indexes.filter(row => row["table_name"] === journalTable);
		const validColumns = columns.length === Object.keys(journalColumns).length && Object.entries(journalColumns).every(([name, type]) => {
			const column = columns.find(row => row["name"] === name);
			const collation = name === "tenant" ? "utf8_bin" : type === "datetime" ? null : "ascii_bin";
			return column && column["type"] === type && column["nullable"] === "NO" && column["extra"] === "" && column["collation"] === collation;
		});
		if (journal["engine"] !== "InnoDB" || journal["type"] !== "BASE TABLE" || !validColumns
			|| indexes.length !== 1 || indexes[0]?.["name"] !== "PRIMARY" || indexes[0]?.["column_name"] !== "step_id"
			|| Number(indexes[0]?.["non_unique"]) !== 0 || indexes[0]?.["prefix_length"] !== null
			|| schema.triggers.some(row => row["table_name"] === journalTable)
			|| schema.references.some(row => row["table_name"] === journalTable || row["target_table"] === journalTable)) {
			blockers.push({ code: "PREPARE_JOURNAL_INCOMPATIBLE", table: journalTable });
		}
	}
	return { blockers, steps, journalExists: Boolean(journal) };
}
