import { DataAccess, Cursor } from "./data-access";
import { DataRow, TenantDataError } from "./data-contract";
import { WppSchema } from "./prepare-plan";

const table = "wpp_tenant_copy_state";
const types: Record<string, string> = { run_id: "varchar(64)", phase: "varchar(8)", entity: "varchar(32)", direction: "varchar(8)", binding_hash: "char(64)", cursor_a: "bigint(20)", cursor_b: "bigint(20)", scanned: "bigint(20)", inserted: "bigint(20)", enriched: "bigint(20)", state: "varchar(16)", updated_at: "datetime" };
const primary = ["run_id", "phase", "entity", "direction"];
export const journalSql = `CREATE TABLE ${table} (${Object.entries(types).map(([name, type]) => `\`${name}\` ${type}${/char/.test(type) ? " CHARACTER SET ascii COLLATE ascii_bin" : ""} NOT NULL`).join(",")}, PRIMARY KEY (${primary.map(k => `\`${k}\``).join(",")})) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`;
export interface Checkpoint { cursor: Cursor; scanned: number; inserted: number; enriched: number; done: boolean }
export const emptyCheckpoint = (): Checkpoint => ({ cursor: [-2147483649, -2147483649], scanned: 0, inserted: 0, enriched: 0, done: false });
export function checkDataJournal(schema: WppSchema): boolean {
	const info = schema.tables.find(t => t["name"] === table); if (!info) return false;
	const columns = schema.columns.filter(c => c["table_name"] === table), indexes = schema.indexes.filter(i => i["table_name"] === table);
	if (info["engine"] !== "InnoDB" || info["type"] !== "BASE TABLE" || columns.length !== Object.keys(types).length
		|| !Object.entries(types).every(([name, type]) => columns.some(c => c["name"] === name && c["type"] === type && c["nullable"] === "NO" && c["extra"] === "" && (!/char/.test(type) || c["collation"] === "ascii_bin")))
		|| indexes.length !== primary.length || !primary.every((name, n) => indexes.some(i => i["name"] === "PRIMARY" && Number(i["position"]) === n + 1 && i["column_name"] === name && i["prefix_length"] === null && Number(i["non_unique"]) === 0))
		|| schema.triggers.some(t => t["table_name"] === table) || schema.references.some(r => r["table_name"] === table || r["target_table"] === table))
		throw new TenantDataError("TENANT_COPY_JOURNAL_SCHEMA_CONFLICT");
	return true;
}
export class DataJournal {
	constructor(private readonly target: DataAccess, private readonly runId: string, private readonly binding: string) {}
	async checkBinding(): Promise<void> {
		const rows = await this.target.query<DataRow[]>("journal-binding", `SELECT binding_hash FROM ${table} WHERE run_id = ? AND binding_hash <> ? LIMIT 1`, [this.runId, this.binding]);
		if (rows.length) throw new TenantDataError("TENANT_COPY_BINDING_CONFLICT");
	}
	async load(phase: string, entity: string, direction: string): Promise<Checkpoint> {
		const rows = await this.target.query<DataRow[]>("journal-read", `SELECT * FROM ${table} WHERE run_id = ? AND phase = ? AND entity = ? AND direction = ?`, [this.runId, phase, entity, direction]);
		if (!rows.length) return emptyCheckpoint();
		const row = rows[0]!;
		if (row["binding_hash"] !== this.binding || !["RUNNING", "DONE"].includes(String(row["state"]))) throw new TenantDataError("TENANT_COPY_BINDING_CONFLICT");
		for (const field of ["cursor_a", "cursor_b", "scanned", "inserted", "enriched"]) {
			const value = Number(row[field]); if (!Number.isSafeInteger(value) || value < (field.startsWith("cursor") ? -2147483649 : 0)) throw new TenantDataError("TENANT_COPY_CHECKPOINT_INVALID");
		}
		return { cursor: [Number(row["cursor_a"]), Number(row["cursor_b"])], scanned: Number(row["scanned"]), inserted: Number(row["inserted"]), enriched: Number(row["enriched"]), done: row["state"] === "DONE" };
	}
	async save(phase: string, entity: string, direction: string, point: Checkpoint): Promise<void> {
		await this.target.query("journal-write", `INSERT INTO ${table} (run_id,phase,entity,direction,binding_hash,cursor_a,cursor_b,scanned,inserted,enriched,state,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE cursor_a=VALUES(cursor_a),cursor_b=VALUES(cursor_b),scanned=VALUES(scanned),inserted=VALUES(inserted),enriched=VALUES(enriched),state=VALUES(state),updated_at=VALUES(updated_at)`,
			[this.runId, phase, entity, direction, this.binding, ...point.cursor, point.scanned, point.inserted, point.enriched, point.done ? "DONE" : "RUNNING"]);
	}
}
