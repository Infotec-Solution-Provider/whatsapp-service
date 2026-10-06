import path from "node:path";
import type { OpsAlertsConfig } from "./ops-alerts.types";

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= min ? value : fallback;
}

function parseIds(raw: string): Set<number> {
	return new Set(
		raw
			.split(",")
			.map((part) => Number(part.trim()))
			.filter((id) => Number.isInteger(id) && id > 0)
	);
}

/** Format `instance:userId[,instance:userId]`; invalid entries are ignored. */
export function parseNotifyTargets(raw: string): Array<{ instance: string; userId: number }> {
	const targets: Array<{ instance: string; userId: number }> = [];
	for (const part of raw.split(",")) {
		const [instance, userId] = part.trim().split(":");
		const id = Number(userId);
		if (instance && Number.isInteger(id) && id > 0) targets.push({ instance, userId: id });
	}
	return targets;
}

/** Every threshold has a code default, so deploying needs no .env edit. */
export function loadOpsAlertsConfig(env: NodeJS.ProcessEnv = process.env): OpsAlertsConfig {
	const mode = (env["OPS_ALERTS_WHATSAPP"] || "auto").trim().toLowerCase();
	return {
		enabled: (env["OPS_ALERTS_ENABLED"] || "true").trim().toLowerCase() !== "false",
		dedupWindowMs: numberEnv(env, "OPS_ALERTS_DEDUP_WINDOW_MS", 600_000, 1_000),
		maxPerHour: numberEnv(env, "OPS_ALERTS_MAX_PER_HOUR", 20, 1),
		reminderMs: numberEnv(env, "OPS_ALERTS_REMINDER_MS", 30 * 60_000, 60_000),
		maxReminders: numberEnv(env, "OPS_ALERTS_MAX_REMINDERS", 3, 0),
		stateFile: env["OPS_ALERTS_STATE_FILE"] || path.join(process.cwd(), "data", "ops-alerts-state.json"),
		excludedClientIds: parseIds(env["OPS_ALERTS_EXCLUDED_CLIENT_IDS"] ?? "1,9,10"),
		notifyTargets: parseNotifyTargets(env["OPS_ALERTS_NOTIFY_TARGETS"] ?? "exatron:38"),
		whatsappMode: mode === "on" || mode === "off" ? mode : "auto",
		senderUrl: (env["OPS_ALERTS_SENDER_URL"] || "http://127.0.0.1:7290").replace(/\/+$/, ""),
		whatsappTo: env["OPS_ALERTS_WHATSAPP_TO"] || "555184449218",
		senderTimeoutMs: numberEnv(env, "OPS_ALERTS_SENDER_TIMEOUT_MS", 5_000, 500),
		senderHealthTtlMs: numberEnv(env, "OPS_ALERTS_SENDER_HEALTH_TTL_MS", 60_000, 1_000),
		senderFailureThreshold: numberEnv(env, "OPS_ALERTS_SENDER_FAILURE_THRESHOLD", 5, 1),
		senderBackoffMs: numberEnv(env, "OPS_ALERTS_SENDER_BACKOFF_MS", 15 * 60_000, 1_000),
		senderUnavailableLogMs: numberEnv(env, "OPS_ALERTS_SENDER_UNAVAILABLE_LOG_MS", 30 * 60_000, 1_000),
		slowSendMs: numberEnv(env, "OPS_ALERTS_SLOW_SEND_MS", 20_000, 1_000),
		sessionDownMs: numberEnv(env, "OPS_ALERTS_SESSION_DOWN_MS", 180_000, 1_000),
		sessionAuthDownMs: numberEnv(env, "OPS_ALERTS_SESSION_AUTH_DOWN_MS", 60_000, 1_000),
		disconnectStormThreshold: numberEnv(env, "OPS_ALERTS_DISCONNECT_STORM_THRESHOLD", 10, 1),
		stormCheckMs: numberEnv(env, "OPS_ALERTS_STORM_CHECK_MS", 5 * 60_000, 10_000),
		backlogMs: numberEnv(env, "OPS_ALERTS_BACKLOG_MS", 120_000, 1_000),
		checkIntervalMs: numberEnv(env, "OPS_ALERTS_CHECK_INTERVAL_MS", 60_000, 5_000),
		tickMs: numberEnv(env, "OPS_ALERTS_TICK_MS", 30_000, 1_000),
		scopeWindowMs: numberEnv(env, "OPS_ALERTS_SCOPE_WINDOW_MS", 24 * 60 * 60_000, 60_000),
		bufferSize: 1000
	};
}
