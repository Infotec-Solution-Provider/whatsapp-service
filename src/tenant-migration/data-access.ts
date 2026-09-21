import { PoolConnection } from "mysql2/promise";
import { sql } from "../database/managed-mysql";
import { quote } from "./prepare-contract";
import { DataRow, Entity, fields, keys, sourceColumn, tables, TenantDataError } from "./data-contract";

export type Cursor = [number, number];
export const rowKey = (entity: Entity, row: DataRow) => keys(entity).map(k => String(row[k])).join(":");
export const rowCursor = (entity: Entity, row: DataRow): Cursor => [Number(row[keys(entity)[0]!]), Number(row[keys(entity)[1]!] ?? -1)];
export class DataAccess {
	maxReadBytes = 4 * 1024 * 1024;
	constructor(readonly connection: PoolConnection, readonly source: boolean, readonly tenant: string, readonly timeoutMs: number, readonly progress: (query: string) => void,
		private readonly targetTables: Partial<Record<Entity, string>> = {}) {}
	table(entity: Entity): string { return this.source ? entity : this.targetTables[entity] ?? tables[entity]; }
	query<T>(name: string, statement: string, values: unknown[] = []): Promise<T> {
		this.progress(`${this.source ? "source" : "target"}-${name}`);
		return sql<T>(this.connection, statement, values, this.timeoutMs);
	}
	column(entity: Entity, field: string): string { return `s.${quote(this.source ? sourceColumn(entity, field) : field)}`; }
	select(entity: Entity): string {
		return fields(entity).map(field => {
			const column = this.column(entity, field);
			return `${this.source && field === "mention_metadata" ? `CAST(${column} AS CHAR CHARACTER SET utf8mb4)` : column} AS ${quote(field)}`;
		}).join(",");
	}
	from(entity: Entity): string { return `${quote(this.table(entity))} s`; }
	private sizes(entity: Entity): string {
		return [...keys(entity).map(k => `${this.column(entity, k)} AS ${quote(k)}`), `(${fields(entity).map(f => `COALESCE(OCTET_LENGTH(${this.column(entity, f)}),0)`).join("+")} + 1024) AS __row_bytes`].join(",");
	}
	scope(entity: Entity): { join: string; where: string; values: unknown[] } {
		const association = entity === "contacts_sectors";
		const join = association ? ` JOIN ${quote(this.table("contacts"))} p ON p.id = ${this.column(entity, "contact_id")}` : "";
		const alias = association ? "p" : "s";
		return { join, where: `${alias}.instance = ? AND BINARY ${alias}.instance = BINARY ?`, values: [this.tenant, this.tenant] };
	}
	async page(entity: Entity, cursor: Cursor, limit: number): Promise<{ rows: DataRow[]; exhausted: boolean }> {
		const scope = this.scope(entity), key = keys(entity).map(k => this.column(entity, k));
		const after = key.length === 1 ? `${key[0]} > ?` : `(${key[0]} > ? OR (${key[0]} = ? AND ${key[1]} > ?))`;
		const sizes = await this.query<DataRow[]>("page-sizes", `SELECT ${this.sizes(entity)} FROM ${this.from(entity)}${scope.join} WHERE ${scope.where} AND ${after} ORDER BY ${key.join(",")} LIMIT ${limit}`,
			[...scope.values, ...(key.length === 1 ? [cursor[0]] : [cursor[0], cursor[0], cursor[1]])]);
		const selected: DataRow[] = []; let bytes = 0;
		for (const row of sizes) {
			const size = Number(row["__row_bytes"]);
			if (size > this.maxReadBytes && !selected.length) throw new TenantDataError("TENANT_ROW_EXCEEDS_READ_BUDGET", { entity, key: rowKey(entity, row), source: this.source });
			if (bytes + size > this.maxReadBytes) break;
			bytes += size; selected.push(row);
		}
		const rows = await this.matching(entity, selected);
		const byKey = new Map(rows.map(row => [rowKey(entity, row), row]));
		if (rows.length !== selected.length) throw new TenantDataError("TENANT_DATA_CHANGED_DURING_RUN", { entity });
		return { rows: selected.map(row => byKey.get(rowKey(entity, row))!), exhausted: sizes.length < limit && selected.length === sizes.length };
	}
	async matching(entity: Entity, rows: DataRow[], lock = false): Promise<DataRow[]> {
		if (!rows.length) return [];
		const scope = this.scope(entity), key = keys(entity);
		const condition = key.length === 1 ? `${this.column(entity, key[0]!)} IN (${rows.map(() => "?").join(",")})`
			: rows.map(() => `(${key.map(k => `${this.column(entity, k)} = ?`).join(" AND ")})`).join(" OR ");
		const suffix = `FROM ${this.from(entity)}${this.source ? scope.join : ""} WHERE ${this.source ? `${scope.where} AND ` : ""}(${condition})`;
		const values = [...(this.source ? scope.values : []), ...rows.flatMap(row => key.map(k => row[k]))];
		const sizes = await this.query<DataRow[]>("matching-sizes", `SELECT ${this.sizes(entity)} ${suffix}${lock ? " FOR UPDATE" : ""}`, values);
		if (sizes.reduce((sum, row) => sum + Number(row["__row_bytes"]), 0) > this.maxReadBytes) throw new TenantDataError("TENANT_MATCH_EXCEEDS_READ_BUDGET", { entity, source: this.source });
		return this.query("matching", `SELECT ${this.select(entity)} ${suffix}${lock ? " FOR UPDATE" : ""}`, values);
	}
	async validateReferences(entity: Entity, rows: DataRow[]): Promise<void> {
		const relations: Partial<Record<Entity, Record<string, Entity>>> = {
			chats: { contact_id: "contacts", schedule_id: "schedules" }, messages: { contact_id: "contacts", chat_id: "chats", quoted_id: "messages" },
			schedules: { contact_id: "contacts", chat_id: "chats" }, contacts_sectors: { contact_id: "contacts" },
		};
		for (const [field, parent] of Object.entries(relations[entity] ?? {}) as [string, Entity][]) {
			const ids = [...new Set(rows.map(r => r[field]).filter(v => v !== null && v !== undefined))];
			if (!ids.length) continue;
			const found = await this.query<DataRow[]>("references", `SELECT id FROM ${quote(parent)} WHERE instance = ? AND BINARY instance = BINARY ? AND id IN (${ids.map(() => "?").join(",")})`, [this.tenant, this.tenant, ...ids]);
			const present = new Set(found.map(r => String(r["id"])));
			const bad = rows.find(r => r[field] !== null && !present.has(String(r[field])));
			if (bad) throw new TenantDataError("TENANT_SOURCE_REFERENCE_CONFLICT", { entity, key: rowKey(entity, bad), column: field });
		}
	}
}

export function statementBytes(statement: string, values: unknown[]): number {
	return Buffer.byteLength(statement, "utf8") + 1024 + values.reduce<number>((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value, "utf8") + 16 : 16), 0);
}
export function validateRow(entity: Entity, row: DataRow, columns: DataRow[], budget: number): void {
	for (const field of fields(entity)) {
		const value = row[field], column = columns.find(c => c["table_name"] === tables[entity] && c["name"] === field);
		const type = String(column?.["type"]);
		let invalid = !column || value === undefined || (value === null && column["nullable"] === "NO");
		if (value !== null && value !== undefined) {
			if (/^(int|tinyint|bigint)/.test(type)) {
				invalid ||= !/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value));
				if (/^int\(/.test(type)) invalid ||= Number(value) < -2147483648 || Number(value) > 2147483647;
				if (/^tinyint/.test(type)) invalid ||= ![0, 1].includes(Number(value));
			} else if (/char|text/.test(type)) {
				const string = String(value), limit = /(?:var)?char\((\d+)\)/.exec(type);
				invalid ||= /[\uD800-\uDFFF]/.test(string); // raw utf8/cesu8 columns cannot hold supplementary Unicode.
				if (limit) invalid ||= string.length > Number(limit[1]);
				if (type === "text") invalid ||= Buffer.byteLength(string) > 65535;
			}
		}
		if (invalid) throw new TenantDataError("TENANT_ROW_NOT_REPRESENTABLE", { entity, key: rowKey(entity, row), column: field });
	}
	if (statementBytes("", Object.values(row)) > budget - 8192) throw new TenantDataError("TENANT_ROW_EXCEEDS_PACKET_BUDGET", { entity, key: rowKey(entity, row), budget });
}
