import { DataAccess, Cursor } from "./data-access";
import { DataRow, Entity, TenantDataError } from "./data-contract";
import { WppSchema } from "./prepare-plan";
import { RebuildDigest } from "./rebuild-checksum";

const table = "wpp_tenant_rebuild";
const types: Record<string, string> = { run_id: "varchar(64)", binding_hash: "char(64)", state: "varchar(16)", payload: "longtext", updated_at: "datetime" };
export const rebuildJournalSql = `CREATE TABLE ${table} (${Object.entries(types).map(([name, type]) => `\`${name}\` ${type}${type === "datetime" ? "" : " CHARACTER SET ascii COLLATE ascii_bin"} NOT NULL`).join(",")}, PRIMARY KEY (run_id)) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`;
export interface RebuildPoint extends RebuildDigest { cursor: Cursor; done: boolean }
export interface RebuildState {
	version: 1;
	phase: "CREATING" | "COPYING" | "VERIFYING" | "SWAPPING" | "CLEANUP" | "COMPLETE";
	markers: Record<string, string>;
	points: Record<Entity, RebuildPoint>;
	lastMessages: number;
}

export function checkRebuildJournal(schema: WppSchema): boolean {
	const info = schema.tables.find(t => t["name"] === table); if (!info) return false;
	const columns = schema.columns.filter(c => c["table_name"] === table), indexes = schema.indexes.filter(i => i["table_name"] === table);
	if (info["engine"] !== "InnoDB" || info["type"] !== "BASE TABLE" || columns.length !== Object.keys(types).length
		|| !Object.entries(types).every(([name, type]) => columns.some(c => c["name"] === name && c["type"] === type && c["nullable"] === "NO" && c["extra"] === "" && (type === "datetime" || c["collation"] === "ascii_bin")))
		|| indexes.length !== 1 || indexes[0]?.["name"] !== "PRIMARY" || indexes[0]?.["column_name"] !== "run_id" || indexes[0]?.["prefix_length"] !== null || Number(indexes[0]?.["non_unique"]) !== 0
		|| schema.triggers.some(t => t["table_name"] === table) || schema.references.some(r => r["table_name"] === table || r["target_table"] === table))
		throw new TenantDataError("TENANT_REBUILD_JOURNAL_INVALID");
	return true;
}

export class RebuildJournal {
	constructor(private readonly target: DataAccess, private readonly runId: string, private readonly binding: string) {}
	async load(): Promise<RebuildState | null> {
		const rows = await this.target.query<DataRow[]>("rebuild-state", `SELECT binding_hash,state,payload FROM ${table} WHERE run_id=?`, [this.runId]);
		if (!rows.length) return null;
		const row = rows[0]!;
		if (row["binding_hash"] !== this.binding) throw new TenantDataError("TENANT_COPY_BINDING_CONFLICT");
		let state: RebuildState;
		try { state = JSON.parse(Buffer.from(String(row["payload"]), "base64").toString("utf8")); }
		catch { throw new TenantDataError("TENANT_REBUILD_JOURNAL_INVALID"); }
		if (state.version !== 1 || state.phase !== row["state"] || !["CREATING", "COPYING", "VERIFYING", "SWAPPING", "CLEANUP", "COMPLETE"].includes(state.phase)
			|| !state.points || !state.markers || !Number.isSafeInteger(state.lastMessages) || state.lastMessages < 0) throw new TenantDataError("TENANT_REBUILD_JOURNAL_INVALID");
		return state;
	}
	async save(state: RebuildState): Promise<void> {
		await this.target.query("rebuild-checkpoint", `INSERT INTO ${table} (run_id,binding_hash,state,payload,updated_at) VALUES (?,?,?,?,UTC_TIMESTAMP())
			ON DUPLICATE KEY UPDATE state=VALUES(state),payload=VALUES(payload),updated_at=VALUES(updated_at)`,
			[this.runId, this.binding, state.phase, Buffer.from(JSON.stringify(state), "utf8").toString("base64")]);
	}
}
