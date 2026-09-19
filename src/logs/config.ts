import cron from "node-cron";

export interface LogsConfig {
	storage: "legacy" | "dedicated"; url: string | undefined;
	successDays: number; failedDays: number; cleanupEnabled: boolean;
	cron: string; timezone: string; batchSize: number; maxBatches: number; maxDurationMs: number;
	poolSize: number; maxPending: number;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
	const raw = env[key];
	if (raw === undefined || raw === "") return fallback;
	if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${key}`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
	return value;
}

export function readLogsConfig(env: NodeJS.ProcessEnv = process.env): LogsConfig {
	const storage = env["PROCESS_LOG_STORAGE"] || "legacy";
	if (storage !== "legacy" && storage !== "dedicated") throw new Error("Invalid PROCESS_LOG_STORAGE");
	const enabled = env["PROCESS_LOG_CLEANUP_ENABLED"] || "false";
	if (enabled !== "true" && enabled !== "false") throw new Error("Invalid PROCESS_LOG_CLEANUP_ENABLED");
	const pattern = env["PROCESS_LOG_CLEANUP_CRON"] || "0 19 * * *";
	const timezone = env["PROCESS_LOG_CLEANUP_TIMEZONE"] || "America/Sao_Paulo";
	// One daily wall-clock time, not a wildcard schedule that can hit business hours.
	if (!/^\d{1,2} \d{1,2} \* \* \*$/.test(pattern) || !cron.validate(pattern)) throw new Error("Invalid daily log cleanup schedule");
	try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw new Error("Invalid log cleanup timezone"); }
	if (storage === "dedicated" && !env["LOGS_DATABASE_URL"]) throw new Error("LOGS_DATABASE_URL is required");
	if (enabled === "true" && storage !== "dedicated") throw new Error("Cleanup requires dedicated log storage");
	return {
		storage, url: env["LOGS_DATABASE_URL"], cleanupEnabled: enabled === "true", cron: pattern, timezone,
		successDays: integer(env, "PROCESS_LOG_RETENTION_SUCCESS_DAYS", 7, 0, 36500),
		failedDays: integer(env, "PROCESS_LOG_RETENTION_FAILED_DAYS", 30, 0, 36500),
		batchSize: integer(env, "PROCESS_LOG_CLEANUP_BATCH_SIZE", 500, 1, 2000),
		maxBatches: integer(env, "PROCESS_LOG_CLEANUP_MAX_BATCHES", 20, 1, 1000),
		maxDurationMs: integer(env, "PROCESS_LOG_CLEANUP_MAX_DURATION_SECONDS", 600, 1, 3600) * 1000,
		poolSize: integer(env, "PROCESS_LOG_POOL_SIZE", 2, 1, 10),
		maxPending: integer(env, "PROCESS_LOG_MAX_PENDING", 20, 1, 100),
	};
}

export function retentionCutoffs(config: LogsConfig, now: Date): Array<{ status: "SUCCESS" | "FAILED"; cutoff: Date }> {
	return ([{ status: "SUCCESS", days: config.successDays }, { status: "FAILED", days: config.failedDays }] as const)
		.filter(item => item.days > 0).map(item => ({ status: item.status, cutoff: new Date(now.getTime() - item.days * 86400000) }));
}

export function cleanupScheduleOptions(timezone: string) {
	return { scheduled: true, timezone, recoverMissedExecutions: false, runOnInit: false };
}
