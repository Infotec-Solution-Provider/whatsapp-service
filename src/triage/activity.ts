import database from "../services/prisma.service";
import { normalizeDatabaseTenant, withDatabaseTenant } from "../utils/database-tenant-context";
import type { TriageReader } from "./access";
import { TRIAGE_CHAT_MARKER } from "./constants";

type ActivityDatabase = {
	$transaction<T>(run: (tx: TriageReader) => Promise<T>, options: { isolationLevel: "RepeatableRead" }): Promise<T>;
};
interface LabelCount { label: string; count: number }
export interface TriageActivity {
	started: number;
	handedOff: number;
	averageSeconds: number | null;
	pendingIntervention: number;
	failed: number;
	byReason: LabelCount[];
	bySector: LabelCount[];
	chats: {chatId: number; status: string}[];
}
// Aggregates from Prisma may be bigint/Decimal; mysql2 may supply numeric strings.
type SqlCount = number | bigint | string | { toString(): string };
interface CompletedGroup { reason: string; sector: string; total: SqlCount; durationUs: SqlCount }
interface ActiveChat { chatId: number; status: string; pendingIntervention: SqlCount }
const reasons: Record<string, string> = {
	configured: "Fluxo concluído", requested: "Pedido de atendente", invalid: "Respostas inválidas",
	timeout: "Tempo de espera esgotado", delivery: "Falha na entrega", unavailable: "Destino indisponível"
};
function ranked(counts: Map<string, number>): LabelCount[] {
	return [...counts].map(([label, count]) => ({label, count}))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "pt-BR"));
}

/** Each 24h counter uses the time of its own event. The intervention queue uses live sessions of any age. */
export function getTriageActivity(instance: string, channelId: number, db: ActivityDatabase = database, now = new Date()): Promise<TriageActivity> {
	if (!normalizeDatabaseTenant(instance) || !Number.isSafeInteger(channelId) || channelId <= 0 || !Number.isFinite(now.getTime())) {
		throw new Error("Empresa, canal ou horário de referência inválido.");
	}
	const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	return withDatabaseTenant(instance, () => db.$transaction(async tx => {
		const [started] = await tx.$queryRawUnsafe<{total:SqlCount}[]>(
			"SELECT COUNT(*) AS total FROM triage_sessions WHERE instance=? AND channel_id=? AND created_at BETWEEN ? AND ?", instance, channelId, since, now);
		const completed = await tx.$queryRawUnsafe<CompletedGroup[]>(`
			SELECT JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.reason')) AS reason,
			       COALESCE(sec.name, CONCAT('Setor #',JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.sectorId')))) AS sector,
			       COUNT(*) AS total, SUM(TIMESTAMPDIFF(MICROSECOND, s.created_at, e.updated_at)) AS durationUs
			FROM triage_sessions s JOIN triage_effects e ON e.chat_id=s.chat_id AND e.instance=s.instance
			LEFT JOIN sectors sec ON sec.instance=? AND sec.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.sectorId')) AS UNSIGNED)
			WHERE s.instance=? AND s.channel_id=? AND s.status='handed_off'
			  AND e.kind='handoff' AND e.status='done' AND e.updated_at BETWEEN ? AND ?
			GROUP BY reason, sector`, instance, instance, channelId, since, now);
		const [failed] = await tx.$queryRawUnsafe<{total:SqlCount}[]>(`
			SELECT COUNT(DISTINCT s.chat_id) AS total FROM triage_sessions s JOIN triage_effects e ON e.chat_id=s.chat_id AND e.instance=s.instance
			WHERE s.instance=? AND s.channel_id=? AND e.status IN ('failed','unknown') AND e.updated_at BETWEEN ? AND ?`,
			instance, channelId, since, now);
		const active = await tx.$queryRawUnsafe<ActiveChat[]>(`
			SELECT q.chatId, IF(q.needsHelp, 'intervention', q.status) AS status, SUM(q.needsHelp) OVER () AS pendingIntervention
			FROM (
				SELECT s.chat_id AS chatId, s.status, s.updated_at, (s.status='handoff' AND EXISTS (
					SELECT 1 FROM triage_effects e WHERE e.instance=s.instance AND e.chat_id=s.chat_id
					  AND e.kind='handoff' AND e.status='failed'
					  AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.reason')) IN ('delivery','unavailable')
				)) AS needsHelp
				FROM triage_sessions s JOIN chats c ON c.id=s.chat_id AND c.instance=?
				WHERE s.instance=? AND s.channel_id=? AND s.status IN ('waiting','handoff') AND c.is_finished=0 AND c.bot_id=?
			) q ORDER BY q.needsHelp DESC, q.updated_at, q.chatId LIMIT 50`, instance, instance, channelId, TRIAGE_CHAT_MARKER);
		let handedOff = 0;
		let durationUs = 0;
		const byReason = new Map<string, number>();
		const bySector = new Map<string, number>();
		for (const group of completed) {
			const total = Number(group.total);
			const reason = Object.hasOwn(reasons, group.reason) ? reasons[group.reason]! : "Outro motivo";
			byReason.set(reason, (byReason.get(reason) ?? 0) + total);
			bySector.set(group.sector, (bySector.get(group.sector) ?? 0) + total);
			handedOff += total;
			durationUs += Number(group.durationUs);
		}
		return { started: Number(started?.total ?? 0), handedOff, averageSeconds: handedOff ? Math.round(durationUs / handedOff / 1_000_000) : null,
			pendingIntervention: Number(active[0]?.pendingIntervention ?? 0), failed: Number(failed?.total ?? 0),
			byReason: ranked(byReason), bySector: ranked(bySector), chats: active.map(({chatId, status}) => ({chatId: Number(chatId), status})) };
	}, { isolationLevel: "RepeatableRead" }));
}
