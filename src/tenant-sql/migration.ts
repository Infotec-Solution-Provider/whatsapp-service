import { createHash } from "node:crypto";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { Prisma } from "@prisma/client";

export const SOURCE_DATABASE = "homolog-whatsapp";
export const TABLE_PREFIX = "wpp_runtime_";
export const HOMOLOG_TENANTS = [
	{ instance: "homolog", database: "homolog-crm", slot: 1, autoIncrementOffset: 1 },
	{ instance: "suprimaxxi", database: "homolog-crm-suprimaxxi", slot: 2, autoIncrementOffset: 2 }
] as const;
export type TenantMigrationIdentity = (typeof HOMOLOG_TENANTS)[number];
type Model = (typeof Prisma.dmmf.datamodel.models)[number];
type Edge = { table: string; columns: string[]; references: string[] };
export type NativeMigrationTable = {
	model: string; source: string; destination: string; columns: string[]; keys: string[];
	instanceColumn: string | null; edges: Edge[]; joins: Edge[]; autoIncrementColumn: string | null;
};
export type TableVerification = { count: number; checksum: string };
export type OmittedForeignKey = { constraint: string; referencedTable: string; invalidRows: number; reason: string };
export type NativeMigrationTablePlan = NativeMigrationTable & TableVerification & {
	ddl: string; schemaChecksum: string; omittedForeignKeys: OmittedForeignKey[];
};
export type NativeMigrationPlan = {
	tenant: TenantMigrationIdentity; tables: NativeMigrationTablePlan[]; idFloor: number;
	sharedParameters: number; unownedParameters: number;
};
const EXCLUDED_MODELS = /^(ProcessLog|FrontendPerformance.*|InstanceMigration.*)$/;
const JOURNAL_TABLE = `${TABLE_PREFIX}migration_journal`;
const MAX_INT = 2_147_483_647;
const QUERY_TIMEOUT = 120_000;

export class NativeMigrationError extends Error {
	constructor(public readonly code: string, public readonly table = "") { super(code); }
}

export function quoteMigrationIdentifier(value: string): string {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new NativeMigrationError("INVALID_IDENTIFIER");
	return `\`${value}\``;
}
const qualified = (database: string, table: string) => `${quoteMigrationIdentifier(database)}.${quoteMigrationIdentifier(table)}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const columnName = (model: Model, name: string) => {
	const field = model.fields.find(item => item.name === name);
	if (!field) throw new NativeMigrationError("METADATA_FIELD_MISSING", model.name);
	return field.dbName || field.name;
};

/** DMMF is used as build metadata only. No Prisma client or database query is instantiated. */
export function buildNativeMigrationMetadata(models: readonly Model[] = Prisma.dmmf.datamodel.models): NativeMigrationTable[] {
	const active = models.filter(model => !EXCLUDED_MODELS.test(model.name));
	const byModel = new Map(active.map(model => [model.name, model]));
	const tables = active.map<NativeMigrationTable>(model => {
		const scalarFields = model.fields.filter(field => field.kind !== "object");
		const idFields = scalarFields.filter(field => field.isId).map(field => field.name);
		const keys = idFields.length ? idFields : model.primaryKey?.fields || model.uniqueFields.find(fields => fields.every(name => model.fields.find(field => field.name === name)?.isRequired === true)) || [];
		if (!keys.length) throw new NativeMigrationError("STABLE_KEY_REQUIRED", model.name);
		const edges: Edge[] = model.fields.filter(field => field.kind === "object" && field.relationFromFields?.length && byModel.has(field.type)).map(field => ({
			table: byModel.get(field.type)!.dbName || field.type,
			columns: (field.relationFromFields || []).map(name => columnName(model, name)),
			references: (field.relationToFields || []).map(name => columnName(byModel.get(field.type)!, name))
		}));
		const instance = scalarFields.find(field => field.name === "instance");
		const auto = scalarFields.find(field => typeof field.default === "object" && field.default !== null && "name" in field.default && field.default.name === "autoincrement");
		return {
			model: model.name, source: model.dbName || model.name, destination: `${TABLE_PREFIX}${model.dbName || model.name}`,
			columns: scalarFields.map(field => field.dbName || field.name), keys: keys.map(name => columnName(model, name)),
			instanceColumn: instance ? instance.dbName || instance.name : null, edges, joins: [], autoIncrementColumn: auto ? auto.dbName || auto.name : null
		} satisfies NativeMigrationTable;
	});
	const byTable = new Map(tables.map(table => [table.source, table]));
	// These existing ownership references are not declared as Prisma relations.
	for (const [table, column, parent] of [
		["remote_inbound_event_inbox", "client_id", "clients"],
		["message_flow_metrics", "flow_id", "message_flows"],
		["message_flow_versions", "flow_id", "message_flows"]
	]) {
		const child = byTable.get(table!);
		if (child && byTable.has(parent!)) child.edges.push({ table: parent!, columns: [column!], references: ["id"] });
	}
	// An explicit association also needs both owners; a cross-tenant sector ID must
	// never be imported merely because its contact belongs to the requested tenant.
	const contactSector = byTable.get("contacts_sectors");
	if (contactSector) contactSector.joins = contactSector.edges;
	const joins = new Set<string>();
	for (const model of active) for (const field of model.fields) {
		if (field.kind !== "object" || !field.isList || field.relationFromFields?.length || !byModel.has(field.type) || !field.relationName) continue;
		const peer = byModel.get(field.type)!;
		const inverse = peer.fields.find(item => item.kind === "object" && item.isList && item.relationName === field.relationName && item.type === model.name);
		if (!inverse || joins.has(field.relationName)) continue;
		joins.add(field.relationName);
		const pair = [model, peer].sort((a, b) => a.name.localeCompare(b.name));
		const source = `_${field.relationName}`;
		const joinEdges = pair.map((owner, index) => {
			const id = owner.fields.find(item => item.isId);
			if (!id) throw new NativeMigrationError("JOIN_OWNER_ID_REQUIRED", source);
			return { table: owner.dbName || owner.name, columns: [index === 0 ? "A" : "B"], references: [id.dbName || id.name] };
		});
		tables.push({ model: source, source, destination: `${TABLE_PREFIX}${source}`, columns: ["A", "B"], keys: ["A", "B"], instanceColumn: null, edges: joinEdges, joins: joinEdges, autoIncrementColumn: null });
	}
	for (const table of tables) { quoteMigrationIdentifier(table.source); quoteMigrationIdentifier(table.destination); }
	return tables;
}

function ownershipPath(table: NativeMigrationTable, tables: NativeMigrationTable[], visited = new Set<string>()): Edge[] | null {
	if (table.instanceColumn) return [];
	if (visited.has(table.source)) return null;
	const nextVisited = new Set(visited).add(table.source);
	for (const edge of table.edges) {
		const parent = tables.find(item => item.source === edge.table);
		if (!parent) continue;
		const path = ownershipPath(parent, tables, nextVisited);
		if (path) return [edge, ...path];
	}
	return null;
}

/** The tenant value is bound separately; callers never interpolate a tenant into SQL. */
export function buildNativeOwnershipPredicate(table: NativeMigrationTable, tables: NativeMigrationTable[], alias = "s"): { sql: string; parameters: string[] } {
	quoteMigrationIdentifier(alias);
	if (table.source === "parameters") {
		return { sql: `(${alias}.\`instance\` = ? OR (${alias}.\`instance\` IS NULL AND ${alias}.\`scope\` = 'SECTOR' AND EXISTS (SELECT 1 FROM ${qualified(SOURCE_DATABASE, "sectors")} p WHERE p.\`id\` = ${alias}.\`sectorId\` AND p.\`instance\` = ?)))`, parameters: ["tenant", "tenant"] };
	}
	if (table.instanceColumn) return { sql: `${alias}.${quoteMigrationIdentifier(table.instanceColumn)} = ?`, parameters: ["tenant"] };
	const paths = table.joins.length ? table.joins.map(edge => [edge, ...(ownershipPath(tables.find(item => item.source === edge.table)!, tables) || [])]) : [ownershipPath(table, tables)];
	if (paths.some(path => !path)) throw new NativeMigrationError("TENANT_OWNERSHIP_REQUIRED", table.source);
	const parameters: string[] = [];
	const clauses = paths.map((path, pathIndex) => {
		let cursor = table;
		let currentAlias = alias;
		const build = (index: number): string => {
			const edge = path![index];
			if (!edge) {
				if (!cursor.instanceColumn) throw new NativeMigrationError("TENANT_OWNERSHIP_REQUIRED", table.source);
				parameters.push("tenant");
				return `${currentAlias}.${quoteMigrationIdentifier(cursor.instanceColumn)} = ?`;
			}
			const parentAlias = `o${pathIndex}_${index}`;
			const equalities = edge.columns.map((column, columnIndex) => `${parentAlias}.${quoteMigrationIdentifier(edge.references[columnIndex]!)} = ${currentAlias}.${quoteMigrationIdentifier(column)}`);
			cursor = tables.find(item => item.source === edge.table)!;
			currentAlias = parentAlias;
			return `EXISTS (SELECT 1 FROM ${qualified(SOURCE_DATABASE, edge.table)} ${parentAlias} WHERE ${equalities.join(" AND ")} AND ${build(index + 1)})`;
		};
		return build(0);
	});
	return { sql: clauses.map(clause => `(${clause})`).join(" AND "), parameters };
}

async function rows(connection: Connection, statement: string, values: unknown[] = []): Promise<RowDataPacket[]> {
	const [result] = await connection.query<RowDataPacket[]>({ sql: statement, timeout: QUERY_TIMEOUT }, values);
	return result;
}
function checksumExpression(columns: string[], alias: string): string {
	return `SHA2(CONCAT_WS('|', ${columns.map(column => `IF(${alias}.${quoteMigrationIdentifier(column)} IS NULL, 'N', CONCAT('V', HEX(CAST(${alias}.${quoteMigrationIdentifier(column)} AS BINARY))))`).join(", ")}), 256)`;
}
async function scanTable(connection: Connection, table: NativeMigrationTable, tenant: string, database: string, source: boolean, batchSize: number, visit?: (batch: RowDataPacket[]) => Promise<void>): Promise<TableVerification> {
	const ownership = source ? buildNativeOwnershipPredicate(table, buildNativeMigrationMetadata()) : { sql: "1 = 1", parameters: [] };
	const parameters = ownership.parameters.map(() => tenant);
	const tableName = source ? table.source : table.destination;
	let lastKey: unknown[] | null = null;
	let count = 0;
	const digest = createHash("sha256");
	for (;;) {
		const cursor = lastKey ? ` AND (${table.keys.map(key => `s.${quoteMigrationIdentifier(key)}`).join(", ")}) > (${table.keys.map(() => "?").join(", ")})` : "";
		const batch = await rows(connection, `SELECT ${table.columns.map(column => `s.${quoteMigrationIdentifier(column)}`).join(", ")}, ${checksumExpression(table.columns, "s")} AS __migration_checksum FROM ${qualified(database, tableName)} s WHERE ${ownership.sql}${cursor} ORDER BY ${table.keys.map(key => `s.${quoteMigrationIdentifier(key)}`).join(", ")} LIMIT ${batchSize}`, [...parameters, ...(lastKey || [])]);
		if (!batch.length) break;
		for (const row of batch) digest.update(String(row["__migration_checksum"])).update("\n");
		count += batch.length;
		if (visit) await visit(batch);
		lastKey = table.keys.map(key => batch[batch.length - 1]![key]);
	}
	return { count, checksum: digest.digest("hex") };
}

export function rewriteNativeCreateTable(ddl: string, table: NativeMigrationTable, available: NativeMigrationTable[], omittedConstraints: Set<string>): string {
	const lines = ddl.split("\n").filter(line => {
		const constraint = line.match(/CONSTRAINT `([^`]+)` FOREIGN KEY/);
		return !constraint || !omittedConstraints.has(constraint[1]!);
	});
	let rewritten = lines.join("\n").replace(/^CREATE TABLE `[^`]+`/, `CREATE TABLE ${quoteMigrationIdentifier(table.destination)}`).replace(/,\s*\n\)/, "\n)").replace(/\bAUTO_INCREMENT=\d+\s*/g, "");
	rewritten = rewritten.replace(/REFERENCES (?:`[^`]+`\.)?`([^`]+)`/g, (_match, source: string) => {
		const target = available.find(item => item.source === source);
		if (!target) throw new NativeMigrationError("UNMAPPED_FOREIGN_KEY", table.source);
		return `REFERENCES ${quoteMigrationIdentifier(target.destination)}`;
	});
	rewritten = rewritten.replace(/CONSTRAINT `([^`]+)`/g, (_match, name: string) => `CONSTRAINT ${quoteMigrationIdentifier(`wrs_${hash(`${table.destination}:${name}`).slice(0, 48)}`)}`);
	return rewritten;
}

export async function confirmHomologCatalog(connection: Connection, tenants: readonly TenantMigrationIdentity[]): Promise<void> {
	const catalogColumns = await rows(connection, "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'homolog-instances' AND TABLE_NAME = 'clients_servers'");
	for (const required of ["instance_name", "host", "port", "username", "database"])
		if (!catalogColumns.some(row => row["COLUMN_NAME"] === required)) throw new NativeMigrationError("CATALOG_SCHEMA_UNEXPECTED");
	for (const tenant of tenants) {
		const catalog = await rows(connection, "SELECT instance_name, host, port, username, `database` FROM `homolog-instances`.`clients_servers` WHERE instance_name = ?", [tenant.instance]);
		const record = catalog[0];
		if (catalog.length !== 1 || !record || record["host"] !== "127.0.0.1" || Number(record["port"]) !== 3306 || record["username"] !== "homolog" || record["database"] !== tenant.database)
			throw new NativeMigrationError("CATALOG_IDENTITY_MISMATCH", tenant.instance);
	}
}

export async function planNativeTenantMigration(connection: Connection, tenant: TenantMigrationIdentity, batchSize = 500): Promise<NativeMigrationPlan> {
	const metadata = buildNativeMigrationMetadata();
	const result: NativeMigrationTablePlan[] = [];
	let globalMaximum = 0;
	for (const table of metadata) {
		const columns = await rows(connection, "SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", [SOURCE_DATABASE, table.source]);
		if (!columns.length) throw new NativeMigrationError("SOURCE_TABLE_MISSING", table.source);
		if (table.columns.some(column => !columns.some(row => row["COLUMN_NAME"] === column))) throw new NativeMigrationError("SOURCE_SCHEMA_MISSING_FIELD", table.source);
		// Preserve extra physical columns too: they are business data even before regenerating metadata.
		table.columns = columns.map(row => String(row["COLUMN_NAME"]));
		const autoColumn = columns.find(row => String(row["EXTRA"]).includes("auto_increment"));
		if (autoColumn) {
			table.autoIncrementColumn = String(autoColumn["COLUMN_NAME"]);
			const maximum = await rows(connection, `SELECT COALESCE(MAX(${quoteMigrationIdentifier(table.autoIncrementColumn)}), 0) AS maximum FROM ${qualified(SOURCE_DATABASE, table.source)}`);
			globalMaximum = Math.max(globalMaximum, Number(maximum[0]!["maximum"]));
		}
		const show = await rows(connection, `SHOW CREATE TABLE ${qualified(SOURCE_DATABASE, table.source)}`);
		const ddl = String(show[0]!["Create Table"]);
		const omittedForeignKeys: OmittedForeignKey[] = [];
		const foreignKeys = await rows(connection, "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION", [SOURCE_DATABASE, table.source]);
		const constraintNames = [...new Set(foreignKeys.map(row => String(row["CONSTRAINT_NAME"])))];
		for (const constraint of constraintNames) {
			const fields = foreignKeys.filter(row => row["CONSTRAINT_NAME"] === constraint);
			const referencedTable = String(fields[0]!["REFERENCED_TABLE_NAME"]);
			const parent = metadata.find(item => item.source === referencedTable);
			if (!parent) { omittedForeignKeys.push({ constraint, referencedTable, invalidRows: 0, reason: "referenced table excluded from tenant runtime" }); continue; }
			const childOwner = buildNativeOwnershipPredicate(table, metadata, "s");
			const parentOwner = buildNativeOwnershipPredicate(parent, metadata, "p");
			const nullCheck = fields.map(row => `s.${quoteMigrationIdentifier(String(row["COLUMN_NAME"]))} IS NOT NULL`).join(" AND ");
			const matches = fields.map(row => `p.${quoteMigrationIdentifier(String(row["REFERENCED_COLUMN_NAME"]))} = s.${quoteMigrationIdentifier(String(row["COLUMN_NAME"]))}`).join(" AND ");
			const invalid = await rows(connection, `SELECT COUNT(*) AS invalid FROM ${qualified(SOURCE_DATABASE, table.source)} s WHERE ${childOwner.sql} AND ${nullCheck} AND NOT EXISTS (SELECT 1 FROM ${qualified(SOURCE_DATABASE, parent.source)} p WHERE ${matches} AND ${parentOwner.sql})`, [...childOwner.parameters, ...parentOwner.parameters].map(() => tenant.instance));
			const invalidRows = Number(invalid[0]!["invalid"]);
			if (invalidRows) omittedForeignKeys.push({ constraint, referencedTable, invalidRows, reason: "historical orphan or reference outside this tenant" });
		}
		const rewritten = rewriteNativeCreateTable(ddl, table, metadata, new Set(omittedForeignKeys.map(item => item.constraint)));
		const verification = await scanTable(connection, table, tenant.instance, SOURCE_DATABASE, true, batchSize);
		result.push({ ...table, ...verification, ddl: rewritten, schemaChecksum: hash(rewritten), omittedForeignKeys });
	}
	const floor = globalMaximum + 1;
	if (!Number.isSafeInteger(floor) || floor > MAX_INT - 100_000) throw new NativeMigrationError("AUTO_INCREMENT_RANGE_EXHAUSTED");
	const shared = await rows(connection, "SELECT COUNT(*) AS count FROM `homolog-whatsapp`.`parameters` p WHERE p.instance IS NULL AND p.scope = 'SECTOR' AND EXISTS (SELECT 1 FROM `homolog-whatsapp`.`sectors` s WHERE s.id = p.sectorId AND s.instance = ?)", [tenant.instance]);
	const unowned = await rows(connection, "SELECT COUNT(*) AS count FROM `homolog-whatsapp`.`parameters` p WHERE p.instance IS NULL AND NOT (p.scope = 'SECTOR' AND EXISTS (SELECT 1 FROM `homolog-whatsapp`.`sectors` s WHERE s.id = p.sectorId))");
	return { tenant, tables: result, idFloor: floor, sharedParameters: Number(shared[0]!["count"]), unownedParameters: Number(unowned[0]!["count"]) };
}

async function destinationExists(connection: Connection, database: string, table: string): Promise<boolean> {
	return (await rows(connection, "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [database, table])).length === 1;
}

export async function applyNativeTenantMigration(source: Connection, target: Connection, plan: NativeMigrationPlan, batchSize = 500, onProgress?: (table: string, copied: number, total: number) => void): Promise<Record<string, TableVerification>> {
	const database = plan.tenant.database;
	await rows(target, `CREATE TABLE IF NOT EXISTS ${qualified(database, JOURNAL_TABLE)} (source_table VARCHAR(64) PRIMARY KEY, source_database VARCHAR(64) NOT NULL, tenant_instance VARCHAR(191) NOT NULL, schema_checksum CHAR(64) NOT NULL, source_count BIGINT UNSIGNED NOT NULL, source_checksum CHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, copied_count BIGINT UNSIGNED NOT NULL DEFAULT 0, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)) ENGINE=InnoDB`);
	// Validate every existing destination before the first business-table DDL or insert.
	for (const table of plan.tables) {
		const journal = await rows(target, `SELECT * FROM ${qualified(database, JOURNAL_TABLE)} WHERE source_table = ?`, [table.source]);
		const entry = journal[0];
		if (entry && (entry["source_database"] !== SOURCE_DATABASE || entry["tenant_instance"] !== plan.tenant.instance || entry["schema_checksum"] !== table.schemaChecksum || Number(entry["source_count"]) !== table.count || entry["source_checksum"] !== table.checksum)) throw new NativeMigrationError("CHECKPOINT_SOURCE_CHANGED", table.source);
		if (await destinationExists(target, database, table.destination)) {
			const count = await rows(target, `SELECT COUNT(*) AS count FROM ${qualified(database, table.destination)}`);
			if (Number(count[0]!["count"]) > 0 && !entry) throw new NativeMigrationError("DESTINATION_NONEMPTY_WITHOUT_CHECKPOINT", table.source);
			const show = await rows(target, `SHOW CREATE TABLE ${qualified(database, table.destination)}`);
			const actualSchema = String(show[0]!["Create Table"]).replace(/\bAUTO_INCREMENT=\d+\s*/g, "");
			if (hash(actualSchema) !== table.schemaChecksum) throw new NativeMigrationError("DESTINATION_SCHEMA_CHANGED", table.source);
		}
	}
	await rows(target, `USE ${quoteMigrationIdentifier(database)}`);
	await rows(target, "SET SESSION foreign_key_checks = 0");
	try {
		for (const table of plan.tables) {
			if (!await destinationExists(target, database, table.destination)) await rows(target, table.ddl);
			await rows(target, `INSERT IGNORE INTO ${qualified(database, JOURNAL_TABLE)} (source_table, source_database, tenant_instance, schema_checksum, source_count, source_checksum, state) VALUES (?, ?, ?, ?, ?, ?, 'prepared')`, [table.source, SOURCE_DATABASE, plan.tenant.instance, table.schemaChecksum, table.count, table.checksum]);
		}
	} finally { await rows(target, "SET SESSION foreign_key_checks = 1"); }
	const verified: Record<string, TableVerification> = {};
	// Every retained FK was validated against the tenant subset while planning. Loading all
	// tables with checks disabled supports genuine chat/schedule and sector/client cycles.
	await rows(target, "SET SESSION foreign_key_checks = 0");
	try {
		for (const table of plan.tables) {
			let copied = 0;
			const snapshot = await scanTable(source, table, plan.tenant.instance, SOURCE_DATABASE, true, batchSize, async batch => {
				const predicates = batch.map(() => `(${table.keys.map(key => `${quoteMigrationIdentifier(key)} <=> ?`).join(" AND ")})`);
				const existing = await rows(target, `SELECT ${table.keys.map(quoteMigrationIdentifier).join(", ")}, ${checksumExpression(table.columns, "d")} AS __migration_checksum FROM ${qualified(database, table.destination)} d WHERE ${predicates.join(" OR ")}`, batch.flatMap(row => table.keys.map(key => row[key])));
				const keyFor = (row: RowDataPacket) => JSON.stringify(table.keys.map(key => row[key]));
				const existingMap = new Map(existing.map(row => [keyFor(row), String(row["__migration_checksum"])]));
				const missing = batch.filter(row => {
					const previous = existingMap.get(keyFor(row));
					if (previous && previous !== String(row["__migration_checksum"])) throw new NativeMigrationError("DESTINATION_ROW_CONFLICT", table.source);
					return !previous;
				});
				if (missing.length) await rows(target, `INSERT INTO ${qualified(database, table.destination)} (${table.columns.map(quoteMigrationIdentifier).join(", ")}) VALUES ${missing.map(() => `(${table.columns.map(() => "?").join(", ")})`).join(", ")}`, missing.flatMap(row => table.columns.map(column => row[column])));
				copied += batch.length;
				await rows(target, `UPDATE ${qualified(database, JOURNAL_TABLE)} SET state = 'copying', copied_count = ? WHERE source_table = ?`, [copied, table.source]);
				onProgress?.(table.source, copied, table.count);
			});
			if (snapshot.count !== table.count || snapshot.checksum !== table.checksum) throw new NativeMigrationError("SOURCE_SNAPSHOT_CHANGED", table.source);
			const destination = await scanTable(target, table, plan.tenant.instance, database, false, batchSize);
			if (destination.count !== table.count || destination.checksum !== table.checksum) throw new NativeMigrationError("DESTINATION_VERIFICATION_FAILED", table.source);
			verified[table.source] = destination;
			await rows(target, `UPDATE ${qualified(database, JOURNAL_TABLE)} SET state = 'verified', copied_count = ? WHERE source_table = ?`, [destination.count, table.source]);
		}
	} finally { await rows(target, "SET SESSION foreign_key_checks = 1"); }
	// Set the same floor above every source ID, then disjoint odd/even allocation by tenant.
	await rows(target, "SET SESSION auto_increment_increment = 2");
	await rows(target, "SET SESSION auto_increment_offset = ?", [plan.tenant.autoIncrementOffset]);
	for (const table of plan.tables) if (table.autoIncrementColumn) await rows(target, `ALTER TABLE ${qualified(database, table.destination)} AUTO_INCREMENT = ${plan.idFloor}`);
	return verified;
}
