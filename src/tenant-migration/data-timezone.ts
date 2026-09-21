import { DataAccess } from "./data-access";
import { DataRow, legacyDate, TenantDataError } from "./data-contract";

/** Infer only from overlapping legacy rows. Every copied row is checked again. */
export async function resolveLegacyTimezone(source: DataAccess, target: DataAccess, requested: string) {
	if (requested !== "auto") {
		try { new Intl.DateTimeFormat("en", { timeZone: requested }).format(0); }
		catch { throw new TenantDataError("TENANT_LEGACY_TIMEZONE_INVALID"); }
		return { timezone: requested, method: "explicit", observations: 0 };
	}
	const candidates = ["UTC", "America/Sao_Paulo"];
	const scores: Record<string, number> = { UTC: 0, "America/Sao_Paulo": 0 };
	let unmatched = 0, observations = 0;
	const rows = await target.query<DataRow[]>("timezone-sample", "SELECT id, sent_at FROM wpp_messages WHERE instance = ? AND BINARY instance = BINARY ? ORDER BY id LIMIT 100", [target.tenant, target.tenant]);
	if (rows.length) {
		const originals = await source.query<DataRow[]>("timezone-sample", `SELECT id, sent_at FROM messages WHERE instance = ? AND BINARY instance = BINARY ? AND id IN (${rows.map(() => "?").join(",")})`, [source.tenant, source.tenant, ...rows.map(r => r["id"])]);
		const byId = new Map(originals.map(r => [String(r["id"]), r]));
		for (const row of rows) {
			const original = byId.get(String(row["id"])); if (!original || original["sent_at"] === null || row["sent_at"] === null) continue;
			observations++;
			const matches = candidates.filter(tz => legacyDate(original["sent_at"], tz) === row["sent_at"]);
			if (!matches.length) unmatched++;
			for (const tz of matches) scores[tz]!++;
		}
	}
	const consistent = candidates.filter(tz => observations >= 3 && scores[tz] === observations && unmatched === 0);
	if (consistent.length !== 1) throw new TenantDataError("TENANT_LEGACY_TIMEZONE_UNRESOLVED", { observations, scores, unmatched, detail: "No timezone selected. Review the legacy writer timezone; no business rows changed." });
	return { timezone: consistent[0]!, method: "inferred-from-overlap", observations, scores };
}
