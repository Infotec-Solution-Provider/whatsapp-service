import type { OpsAlertInput, OpsAlertSeverity, OpsAlertType } from "./ops-alerts.types";

export const OPS_ALERT_MAX_LENGTH = 600;
const TIME_ZONE = "America/Sao_Paulo";

const SEVERITY_LABELS: Record<OpsAlertSeverity, string> = {
	critical: "[CRÍTICO]",
	high: "[CRÍTICO]",
	warn: "[AVISO]",
	resolved: "[RESOLVIDO]"
};

function title(type: OpsAlertType, slowSendMs: number): string {
	switch (type) {
		case "SEND_FAILED":
			return "Falha no envio";
		case "SEND_SLOW":
			return `Envio lento (>${Math.round(slowSendMs / 1000)} s)`;
		case "SESSION_DOWN":
			return "Sessão fora do ar";
		case "DISCONNECT_STORM":
			return "Desconexões frequentes";
		case "QUEUE_BACKLOG":
			return "Fila de envio atrasada";
	}
}

/** Drops values that look like phone numbers or JIDs (ids only in alerts). */
export function safeIdentifier(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim().slice(0, 64);
	if (!trimmed || trimmed.includes("@") || /\d{8,}/.test(trimmed)) return null;
	return trimmed;
}

function parts(date: Date, options: Intl.DateTimeFormatOptions): Record<string, string> {
	const result: Record<string, string> = {};
	for (const part of new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, hour12: false, ...options }).formatToParts(date)) {
		result[part.type] = part.value;
	}
	return result;
}

export function formatClock(value: string | Date): string | null {
	const date = typeof value === "string" ? new Date(value) : value;
	if (Number.isNaN(date.getTime())) return null;
	const p = parts(date, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	return `${p["hour"]}:${p["minute"]}:${p["second"]}`;
}

export function formatStamp(date: Date): string {
	const p = parts(date, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
	return `${p["day"]}/${p["month"]} ${p["hour"]}:${p["minute"]}`;
}

export function formatSeconds(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))} s`;
}

export interface FormatOptions {
	now: Date;
	slowSendMs: number;
	dedupWindowMs: number;
	/** Occurrences folded into this message. */
	suppressed?: number;
	reminder?: { index: number; max: number };
}

export function formatOpsAlertTitle(alert: OpsAlertInput, slowSendMs: number): string {
	return `${SEVERITY_LABELS[alert.severity]} ${alert.instance} · ${title(alert.type, slowSendMs)}`;
}

/** Plain text, PT-BR, ≤ 600 chars, times in America/Sao_Paulo, identifiers only. */
export function formatOpsAlert(alert: OpsAlertInput, options: FormatOptions): string {
	const refs = alert.refs || {};
	const lines = [formatOpsAlertTitle(alert, options.slowSendMs)];

	const sessionId = safeIdentifier(alert.sessionId);
	const role = refs.fallback === true ? "reserva" : refs.fallback === false ? "principal" : null;
	const qualifiers = [refs.library, role].filter(Boolean).join(", ");
	if (sessionId) {
		lines.push(
			`Sessão ${sessionId}${qualifiers ? ` (${qualifiers})` : ""}${alert.clientId ? ` · cliente ${alert.clientId}` : ""}`
		);
	} else if (alert.clientId) {
		lines.push(`Cliente ${alert.clientId}${qualifiers ? ` (${qualifiers})` : ""}`);
	}

	const ids: string[] = [];
	if (refs.internalMessageId) ids.push(`Mensagem interna ${refs.internalMessageId}`);
	if (refs.messageId) ids.push(`Mensagem ${refs.messageId}`);
	const jobId = safeIdentifier(refs.jobId);
	if (jobId) ids.push(`job ${jobId}`);
	if (ids.length) lines.push(ids.join(" · "));

	if (alert.summary.trim()) lines.push(alert.summary.trim().slice(0, 160));

	const timing: string[] = [];
	if (typeof refs.durationMs === "number") timing.push(`Duração ${formatSeconds(refs.durationMs)}`);
	const firstAttempt = refs.firstAttemptAt ? formatClock(refs.firstAttemptAt) : null;
	if (firstAttempt) timing.push(`1ª tentativa ${firstAttempt}`);
	if (timing.length) lines.push(timing.join(" · "));

	if (options.suppressed && options.suppressed > 0) {
		lines.push(`+${options.suppressed} ocorrências em ${Math.round(options.dedupWindowMs / 60_000)} min`);
	}
	if (options.reminder) lines.push(`Lembrete ${options.reminder.index}/${options.reminder.max}: ainda aberto`);
	lines.push(`in.pulse monitor · ${formatStamp(options.now)}`);

	return truncate(lines);
}

export function formatDigest(
	overflow: Array<{ type: OpsAlertType; instance: string; count: number }>,
	options: { now: Date; maxPerHour: number }
): string {
	const total = overflow.reduce((sum, item) => sum + item.count, 0);
	const detail = overflow
		.slice()
		.sort((a, b) => b.count - a.count)
		.map((item) => `${item.type} ${item.instance} ×${item.count}`)
		.join(" · ");
	return truncate([
		`[RESUMO] in.pulse · ${total} alertas acima do limite (${options.maxPerHour}/h)`,
		detail,
		`in.pulse monitor · ${formatStamp(options.now)}`
	]);
}

function truncate(lines: string[]): string {
	const text = lines.join("\n");
	if (text.length <= OPS_ALERT_MAX_LENGTH) return text;
	const footer = lines[lines.length - 1] || "";
	const head = lines.slice(0, -1).join("\n").slice(0, OPS_ALERT_MAX_LENGTH - footer.length - 2);
	return `${head}…\n${footer}`;
}
