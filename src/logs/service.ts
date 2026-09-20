import cron, { ScheduledTask } from "node-cron";
import { randomUUID } from "node:crypto";
import { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { acquire, createManagedPool, databaseErrorCode, databaseIdentity, mysqlOptions, sql } from "../database/managed-mysql";
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
	private started = false;
	private reporting: ReturnType<typeof setInterval> | undefined;
	private readonly lastDiagnosticAt = new Map<string, number>();
	private lastFailure: { code: string; stage: string; at: string } | undefined;
	private lastSavedAt: string | undefined;
	private requested = 0;
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
	private storageMode(): string {
		const storage = this.config?.storage ?? this.writerConfig?.storage ?? (process.env["PROCESS_LOG_STORAGE"] || "legacy");
		return storage === "dedicated" || storage === "legacy" ? storage : "invalid";
	}
	private status() {
		return { storage: this.storageMode(), requested: this.requested, pending: this.pending.size, ...this.metrics, lastSavedAt: this.lastSavedAt ?? null, lastFailure: this.lastFailure ?? null };
	}
	private diagnostic(error: unknown, stage: "write" | "config" | "admission" | "cleanup" | "startup" = "write"): void {
		const code = databaseErrorCode(error), now = Date.now(), key = `${stage}:${code}`;
		this.lastFailure = { code, stage, at: new Date(now).toISOString() };
		const previous = this.lastDiagnosticAt.get(key);
		if (previous !== undefined && now - previous < 30000) return;
		if (this.lastDiagnosticAt.size >= 64) this.lastDiagnosticAt.clear();
		this.lastDiagnosticAt.set(key, now);
		console.error(JSON.stringify({ component: "process-logs", event: "error", pid: process.pid, code, stage, ...this.status() }));
	}

	public save(record: ProcessLogRecord): void {
		void this.enqueue(record);
	}
	private enqueue(record: ProcessLogRecord, verify = false): Promise<number | null> {
		this.requested++;
		try {
			const config = this.settings();
			if (this.stopped || this.pending.size >= config.maxPending) {
				this.metrics.rejected++; this.diagnostic(new Error(this.stopped ? "Log writer stopped" : "Log queue full"), "admission"); return Promise.resolve(null);
			}
			const operation = this.write(record, verify).then(id => {
				this.metrics.saved++; this.lastSavedAt = new Date().toISOString(); return id;
			}, error => { this.metrics.failed++; this.diagnostic(error); return null; });
			const tracked = operation.then(() => {});
			this.pending.add(tracked);
			void tracked.finally(() => this.pending.delete(tracked));
			return operation;
		} catch (error) { this.metrics.failed++; this.diagnostic(error, "config"); return Promise.resolve(null); }
	}

	private async write(record: ProcessLogRecord, verify: boolean): Promise<number> {
		if (this.settings().storage === "legacy") {
			// Explicit deployment mode; never a fallback on dedicated DB errors.
			const prisma = require("../services/prisma.service").default as typeof import("../services/prisma.service").default;
			const saved = await prisma.processLog.create({ data: record, select: { id: true } });
			if (verify) {
				const found = await prisma.processLog.findUnique({ where: { id: saved.id }, select: { processId: true } });
				if (found?.processId !== record.processId) throw new Error("Log write verification failed");
			}
			return saved.id;
		}
		const connection = await acquire(this.dedicatedPool());
		try {
			const saved = await sql<ResultSetHeader>(connection,
				`INSERT INTO process_logs (instance, process_name, process_id, status, start_time, end_time, duration, input, output, error, error_message, log_entries, created_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM process_log_store WHERE id = 1 AND schema_version = 1 AND state = 'ACTIVE'`,
				[record.instance, record.processName, record.processId, record.status, record.startTime, record.endTime, record.duration, record.input, record.output, record.error, record.errorMessage, record.logEntries, new Date()]);
			if (saved.affectedRows !== 1) throw new Error("Log store not active");
			if (verify) {
				const found = await sql<RowDataPacket[]>(connection, "SELECT process_id FROM process_logs WHERE id = ?", [saved.insertId]);
				if (found[0]?.["process_id"] !== record.processId) throw new Error("Log write verification failed");
			}
			return saved.insertId;
		} finally { connection.release(); }
	}

	/** One synthetic row, through the same admission/writer path as business logs; no retries. */
	public async probe(): Promise<{ verified: boolean; id: number | null; code: string | null }> {
		const now = new Date();
		const id = await this.enqueue({ instance: "system", processName: "process-logs-probe", processId: randomUUID(), status: "SUCCESS", startTime: now, endTime: now, duration: 0, input: "{}", output: "{}", error: "null", errorMessage: "", logEntries: "[]" }, true);
		return { verified: id !== null, id, code: id === null ? this.lastFailure?.code ?? "DATABASE_OPERATION_FAILED" : null };
	}

	/** Read-only check of the actual connection, without exposing credentials or payloads. */
	public async inspect() {
		const config = this.settings();
		if (config.storage === "legacy") {
			const prisma = require("../services/prisma.service").default as typeof import("../services/prisma.service").default;
			const identity = await prisma.$queryRawUnsafe("SELECT DATABASE() AS database_name, @@hostname AS hostname, @@port AS port");
			const latest = await prisma.processLog.findFirst({ orderBy: { id: "desc" }, select: { id: true, createdAt: true } });
			return { storage: config.storage, identity, latest };
		}
		const connection = await acquire(this.dedicatedPool());
		try {
			const identity = await databaseIdentity(connection);
			const state = await sql<RowDataPacket[]>(connection, "SELECT id, schema_version, state FROM process_log_store WHERE id = 1");
			const latest = await sql<RowDataPacket[]>(connection, "SELECT id, created_at FROM process_logs ORDER BY id DESC LIMIT 1");
			return { storage: config.storage, identity, state, latest };
		} finally { connection.release(); }
	}

	public start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		// Report even without incoming work, or when startup configuration is invalid.
		this.reporting = setInterval(() => console.info(JSON.stringify({ component: "process-logs", event: "status", pid: process.pid, ...this.status() })), 60000);
		this.reporting.unref();
		console.info(JSON.stringify({ component: "process-logs", event: "starting", diagnosticsVersion: 2, pid: process.pid, cwd: process.cwd(), module: __filename, storage: this.storageMode() }));
		try {
			const writer = this.settings();
			const target = writer.storage === "dedicated" ? mysqlOptions(writer.url!, writer.poolSize) : null;
			console.info(JSON.stringify({ component: "process-logs", event: "configured", pid: process.pid, storage: writer.storage, poolSize: writer.poolSize, maxPending: writer.maxPending,
				...(target ? { host: target.host, port: target.port, database: target.database } : {}) }));
			void this.probe().then(result => console.info(JSON.stringify({ component: "process-logs", event: "startup-probe", pid: process.pid, storage: this.storageMode(), ...result })))
				.catch(error => this.diagnostic(error, "startup"));
		} catch (error) { this.diagnostic(error, "config"); }
		try {
			const config = this.config ?? readLogsConfig();
			if (this.task || !config.cleanupEnabled) return;
			this.task = cron.schedule(config.cron, () => {
				if (this.cleaning || this.stopped) return;
				this.cleaning = cleanProcessLogs(this.dedicatedPool(), config, { stopped: () => this.stopped })
					.then(result => console.info(JSON.stringify({ component: "process-log-cleanup", ...result })))
					.catch(error => this.diagnostic(error, "cleanup")).finally(() => { this.cleaning = undefined; });
			}, cleanupScheduleOptions(config.timezone));
		} catch (error) { this.diagnostic(error, "startup"); }
	}

	public async stop(): Promise<void> {
		this.stopped = true; this.task?.stop();
		if (this.reporting) clearInterval(this.reporting);
		await Promise.all([...this.pending, this.cleaning]);
		if (this.pool) await this.pool.end();
	}
}

export default new ProcessLogsService();
