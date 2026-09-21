import { DataAccess, rowKey, statementBytes } from "./data-access";
import { DataRow, Entity, fields, keys, tables, TenantDataError } from "./data-contract";
import { quote } from "./prepare-contract";
import { legacyContract } from "./legacy-contract";

export async function checkTargetUniqueKeys(target: DataAccess, entity: Entity, inserts: DataRow[], budget: number): Promise<void> {
	for (const index of legacyContract[tables[entity]].uniqueIndexes.filter(i => !i.primary)) {
		const eligible = inserts.filter(row => index.columns.every(column => row[column] !== null));
		for (let offset = 0; offset < eligible.length; offset += 50) {
			const rows = eligible.slice(offset, offset + 50);
			const statement = rows.map(() => `SELECT id AS existing_id, ? AS incoming_id FROM ${quote(tables[entity])} WHERE ${index.columns.map(c => `${quote(c)} = ?`).join(" AND ")}`).join(" UNION ALL ");
			const values = rows.flatMap(row => [row["id"], ...index.columns.map(c => row[c])]);
			if (statementBytes(statement, values) > budget) throw new TenantDataError("TENANT_STATEMENT_EXCEEDS_PACKET_BUDGET", { entity, budget });
			const matches = await target.query<DataRow[]>("unique-check", statement, values);
			const collisions = matches.filter(row => String(row["existing_id"]) !== String(row["incoming_id"]));
			if (collisions.length) throw new TenantDataError("TENANT_UNIQUE_KEY_CONFLICT", { entity, columns: index.columns, keys: collisions.slice(0, 20).map(r => ({ incoming: r["incoming_id"], existing: r["existing_id"] })) });
		}
	}
}

/** Explicit INSERTs and source-authoritative updates by primary key. Caller holds row locks and audits updates. */
export async function writeRows(target: DataAccess, entity: Entity, inserts: DataRow[], updates: { row: DataRow; columns: string[] }[], budget: number): Promise<void> {
	const execute = async (statement: string, values: unknown[]) => {
		if (statementBytes(statement, values) > budget) throw new TenantDataError("TENANT_STATEMENT_EXCEEDS_PACKET_BUDGET", { entity, budget });
		await target.query("write-page", statement, values);
	};
	const columns = fields(entity);
	// Conservative byte batching, even when the configured row batch is large.
	let batch: DataRow[] = [];
	const insertSql = (size: number) => `INSERT INTO ${quote(tables[entity])} (${columns.map(quote).join(",")}) VALUES ${Array.from({ length: size }, () => `(${columns.map(() => "?").join(",")})`).join(",")}`;
	const insertValues = (rows: DataRow[]) => rows.flatMap(row => columns.map(c => row[c]));
	for (const row of inserts) {
		if (batch.length && statementBytes(insertSql(batch.length + 1), insertValues([...batch, row])) > budget) { await execute(insertSql(batch.length), insertValues(batch)); batch = []; }
		batch.push(row);
	}
	if (batch.length) await execute(insertSql(batch.length), insertValues(batch));
	if (entity === "contacts_sectors" && updates.length) throw new TenantDataError("TENANT_ASSOCIATION_UPDATE_FORBIDDEN");
	// Group by changed column: no upsert can accidentally match another provider's unique ID.
	for (const column of [...new Set(updates.flatMap(e => e.columns))]) {
		if (!columns.includes(column) || [...keys(entity), "instance", "original_id"].includes(column)) throw new TenantDataError("TENANT_IDENTITY_UPDATE_FORBIDDEN", { entity, column });
		let group: DataRow[] = [];
		const statement = (size: number) => `UPDATE ${quote(tables[entity])} SET ${quote(column)} = CASE id ${Array.from({ length: size }, () => "WHEN ? THEN ?").join(" ")} ELSE ${quote(column)} END WHERE instance = ? AND BINARY instance = BINARY ? AND id IN (${Array.from({ length: size }, () => "?").join(",")})`;
		const values = (rows: DataRow[]) => [...rows.flatMap(row => [row["id"], row[column]]), target.tenant, target.tenant, ...rows.map(row => row["id"])];
		for (const item of updates.filter(e => e.columns.includes(column))) {
			if (group.length && statementBytes(statement(group.length + 1), values([...group, item.row])) > budget) { await execute(statement(group.length), values(group)); group = []; }
			group.push(item.row);
		}
		if (group.length) await execute(statement(group.length), values(group));
	}
}

export function checkUniquePage(entity: Entity, rows: DataRow[]): void {
	const seen = new Set<string>();
	for (const row of rows) {
		const key = rowKey(entity, row);
		if (seen.has(key) || keys(entity).some(k => !Number.isSafeInteger(Number(row[k])) || Number(row[k]) < 0)) throw new TenantDataError("TENANT_SOURCE_KEY_INVALID", { entity, key });
		seen.add(key);
	}
}
