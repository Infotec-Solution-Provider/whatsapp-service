import cron, { ScheduledTask } from "node-cron";
import { Pool, ResultSetHeader } from "mysql2/promise";
import { acquire, createManagedPool, databaseErrorCode, sql } from "../database/managed-mysql";
import { cleanProcessLogs } from "./cleanup";
import { cleanupScheduleOptions, LogsConfig, readLogsConfig } from "./config";

export interface ProcessLogRecord {
	instance: string; processName: string; processId: string; status: "SUCCESS" | "FAILED";
	startTime: Date; endTime: Date; duration: number; input: string; output: string;
	error: string; errorMessage: string; logEntries: string;
}

export class ProcessLogsService {
	private pool: Pool | undefined;
	private config: LogsConfig | undefined;
	private writerConfig: LogsConfig | undefined;
	private task: ScheduledTask | undefined;
	private pending = new Set<Promise<void>>();
	private cleaning: Promise<unknown> | undefined;
	private stopped = false;
	private lastDiagnosticAt = 0;
	public readonly metrics = { saved: 0, failed: 0, rejected: 0 };
	constructor(config?: LogsConfig) { this.config = config; }

	private settings(): LogsConfig {
		// A malformed retention setting disables cleanup, not log ingestion.
		return this.config ?? (this.writerConfig ??= readLogsConfig({
			PROCESS_LOG_STORAGE: process.env["PROCESS_LOG_STORAGE"], LOGS_DATABASE_URL: process.env["LOGS_DATABASE_URL"],
			PROCESS_LOG_POOL_SIZE: process.env["PROCESS_LOG_POOL_SIZE"], PROCESS_LOG_MAX_PENDING: process.env["PROCESS_LOG_MAX_PENDING"],
		}));
	}
	private dedicatedPool(): Pool { return this.pool ??= createManagedPool(this.settings().url!, this.settings().poolSize, this.settings().maxPending); }
	private diagnostic(error: unknown): void {
		if (Date.now() - this.lastDiagnosticAt < 30000) return;
		this.lastDiagnosticAt = Date.now();
		console.error(JSON.stringify({ component: "process-logs", code: databaseErrorCode(error), ...this.metrics }));
	}

	public save(record: ProcessLogRecord): void {
		try {
			const config = this.settings();
			if (this.stopped || this.pending.size >= config.maxPending) {
				this.metrics.rejected++; this.diagnostic(null); return;
			}
			const operation = this.write(record).then(() => { this.metrics.saved++; }, error => { this.metrics.failed++; this.diagnostic(error); });
			this.pending.add(operation);
			void operation.finally(() => this.pending.delete(operation));
		} catch (error) { this.metrics.failed++; this.diagnostic(error); }
	}

	private async write(record: ProcessLogRecord): Promise<void> {
		if (this.settings().storage === "legacy") {
			// Explicit deployment mode; never a fallback on dedicated DB errors.
			const prisma = require("../services/prisma.service").default as typeof import("../services/prisma.service").default;
			await prisma.processLog.create({ data: record });
			return;
		}
		const connection = await acquire(this.dedicatedPool());
		try {
			const saved = await sql<ResultSetHeader>(connection,
				`INSERT INTO process_logs (instance, process_name, process_id, status, start_time, end_time, duration, input, output, error, error_message, log_entries, created_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM process_log_store WHERE id = 1 AND schema_version = 1 AND state = 'ACTIVE'`,
				[record.instance, record.processName, record.processId, record.status, record.startTime, record.endTime, record.duration, record.input, record.output, record.error, record.errorMessage, record.logEntries, new Date()]);
			if (saved.affectedRows !== 1) throw new Error("Log store not active");
		} finally { connection.release(); }
	}

	public start(): void {
		try {
			const config = this.config ?? readLogsConfig();
			if (this.task || !config.cleanupEnabled) return;
			this.task = cron.schedule(config.cron, () => {
				if (this.cleaning || this.stopped) return;
				this.cleaning = cleanProcessLogs(this.dedicatedPool(), config, { stopped: () => this.stopped })
					.then(result => console.info(JSON.stringify({ component: "process-log-cleanup", ...result })))
					.catch(error => this.diagnostic(error)).finally(() => { this.cleaning = undefined; });
			}, cleanupScheduleOptions(config.timezone));
		} catch (error) { this.diagnostic(error); }
	}

	public async stop(): Promise<void> {
		this.stopped = true; this.task?.stop();
		await Promise.all([...this.pending, this.cleaning]);
		if (this.pool) await this.pool.end();
	}
}

export default new ProcessLogsService();
