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
	let unmatched = 0, observations = 0, matchedIds = 0, missingInSource = 0, nullDates = 0;
	// Oldest rows alone can predate the history available in the central database.
	// Keep both ends of the sample: recent evidence must not hide old disagreements.
	const oldest = await target.query<DataRow[]>("timezone-sample-oldest", "SELECT id, sent_at FROM wpp_messages WHERE instance = ? AND BINARY instance = BINARY ? ORDER BY id ASC LIMIT 100", [target.tenant, target.tenant]);
	const recent = await target.query<DataRow[]>("timezone-sample-recent", "SELECT id, sent_at FROM wpp_messages WHERE instance = ? AND BINARY instance = BINARY ? ORDER BY id DESC LIMIT 100", [target.tenant, target.tenant]);
	const byTargetId = new Map<string, DataRow>();
	for (const row of [...oldest, ...recent]) {
		const previous = byTargetId.get(String(row["id"]));
		if (previous && previous["sent_at"] !== row["sent_at"]) throw new TenantDataError("TENANT_LEGACY_TIMEZONE_UNRESOLVED", { reason: "SAMPLE_CHANGED", detail: "A sampled timestamp changed between reads. Repeat with writers paused." });
		byTargetId.set(String(row["id"]), row);
	}
	const rows = [...byTargetId.values()];
	if (rows.length) {
		const originals = await source.query<DataRow[]>("timezone-sample", `SELECT id, sent_at FROM messages WHERE instance = ? AND BINARY instance = BINARY ? AND id IN (${rows.map(() => "?").join(",")})`, [source.tenant, source.tenant, ...rows.map(r => r["id"])]);
		const byId = new Map(originals.map(r => [String(r["id"]), r]));
		for (const row of rows) {
			const original = byId.get(String(row["id"]));
			if (!original) { missingInSource++; continue; }
			matchedIds++;
			if (original["sent_at"] === null || row["sent_at"] === null) { nullDates++; continue; }
			observations++;
			const matches = candidates.filter(tz => legacyDate(original["sent_at"], tz) === row["sent_at"]);
			if (!matches.length) unmatched++;
			for (const tz of matches) scores[tz]!++;
		}
	}
	const sample = { strategy: "target-oldest-and-recent", oldestRows: oldest.length, recentRows: recent.length, uniqueTargetRows: rows.length, matchedIds, missingInSource, nullDates };
	const consistent = candidates.filter(tz => observations >= 3 && scores[tz] === observations && unmatched === 0);
	if (consistent.length !== 1) throw new TenantDataError("TENANT_LEGACY_TIMEZONE_UNRESOLVED", {
		observations, scores, unmatched, sample,
		reason: rows.length === 0 ? "NO_TARGET_SAMPLE" : matchedIds === 0 ? "NO_OVERLAP_IN_SAMPLE" : observations < 3 ? "INSUFFICIENT_DATED_PAIRS" : "INCONSISTENT_DATES",
		detail: "No timezone selected. Review sample overlap and dates; no business rows changed.",
	});
	return { timezone: consistent[0]!, method: "inferred-from-overlap", observations, scores, sample };
}
