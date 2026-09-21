import { createHash } from "node:crypto";
import { DataAccess } from "./data-access";
import { DataRow, Entity, fields, TenantDataError } from "./data-contract";
import { quote } from "./prepare-contract";

export interface RebuildDigest { count: number; high: string; low: string }
export const emptyDigest = (): RebuildDigest => ({ count: 0, high: "0", low: "0" });

/** Order-independent transport check, including primary keys, NULL and byte lengths. Not a security signature. */
export function addDigest(previous: RebuildDigest, entity: Entity, rows: DataRow[]): RebuildDigest {
	let high = BigInt(previous.high), low = BigInt(previous.low);
	for (const row of rows) {
		const value = fields(entity).map(field => row[field] === null ? "N;" : `S${Buffer.byteLength(String(row[field]), "utf8")}:${row[field]};`).join("");
		const hash = createHash("md5").update(value, "utf8").digest("hex");
		high ^= BigInt(`0x${hash.slice(0, 16)}`); low ^= BigInt(`0x${hash.slice(16)}`);
	}
	return { count: previous.count + rows.length, high: high.toString(), low: low.toString() };
}

export async function verifyDigest(target: DataAccess, entity: Entity, table: string, expected: RebuildDigest): Promise<void> {
	const parts = fields(entity).map(field => {
		const column = quote(field), text = `CONVERT(${column} USING utf8)`;
		return `IF(${column} IS NULL,'N;',CONCAT('S',OCTET_LENGTH(${text}),':',${text},';'))`;
	});
	const hash = `MD5(CONCAT(${parts.join(",")}))`;
	const rows = await target.query<DataRow[]>("rebuild-checksum", `SELECT COUNT(*) AS n,
		BIT_XOR(CAST(CONV(SUBSTRING(${hash},1,16),16,10) AS UNSIGNED)) AS hi,
		BIT_XOR(CAST(CONV(SUBSTRING(${hash},17,16),16,10) AS UNSIGNED)) AS lo FROM ${quote(table)}`);
	const got = rows[0];
	if (!got || String(got["n"]) !== String(expected.count) || String(got["hi"]) !== expected.high || String(got["lo"]) !== expected.low)
		throw new TenantDataError("TENANT_REBUILD_CHECKSUM_MISMATCH", { entity, expectedRows: expected.count, actualRows: got?.["n"] });
}
