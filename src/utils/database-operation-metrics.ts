import { performance } from "node:perf_hooks";

const MAX_GROUPS = 128;
const MAX_ACTIVE = 256;
const MAX_RECENT = 20;
const REPORT_INTERVAL_MS = 5_000;

interface Totals {
	operation: string;
	completed: number;
	failed: number;
	slow: number;
	inFlight: number;
	peakInFlight: number;
	totalMs: number;
	maxMs: number;
	maxResultRows: number;
}
interface Observation {
	at: string;
	operation: string;
	durationMs: number;
	failed: boolean;
	code: string | null;
	resultRows: number | null;
}
interface Options {
	enabled?: boolean;
	slowMs?: number;
	clock?: () => number;
	report?: (entry: Record<string, unknown>) => void;
}

/** Application elapsed time, including pool waits; never SQL execution time.
 * Retains only bounded numeric metadata, never arguments, SQL, results or errors.
 */
export class DatabaseOperationMetrics {
	private readonly enabled: boolean;
	private readonly slowMs: number;
	private readonly clock: () => number;
	private readonly groups = new Map<string, Totals>();
	private readonly active = new Map<object, { operation: string; started: number }>();
	private readonly recent: Observation[] = [];
	private inFlight = 0;
	private lastReport = -Infinity;
	private suppressed = 0;

	constructor(private readonly options: Options = {}) {
		this.enabled = options.enabled ?? true;
		this.slowMs = Number.isFinite(options.slowMs) && options.slowMs! >= 1 ? options.slowMs! : 1_000;
		this.clock = options.clock ?? (() => performance.now());
	}

	async measure<T>(model: string | undefined, operation: string, execute: () => Promise<T>): Promise<T> {
		if (!this.enabled) return execute();
		// Names come from Prisma metadata, not SQL or request input.
		const label = `${model ?? "raw"}.${operation}`;
		let key = /^[A-Za-z0-9_.$]{1,120}$/.test(label) ? label : "other";
		if (!this.groups.has(key) && this.groups.size >= MAX_GROUPS - 1) key = "other";
		let totals = this.groups.get(key);
		if (!totals) {
			totals = { operation: key, completed: 0, failed: 0, slow: 0, inFlight: 0, peakInFlight: 0, totalMs: 0, maxMs: 0, maxResultRows: 0 };
			this.groups.set(key, totals);
		}
		const started = this.clock();
		const token = {};
		if (this.active.size < MAX_ACTIVE) this.active.set(token, { operation: key, started });
		this.inFlight++;
		totals.inFlight++;
		totals.peakInFlight = Math.max(totals.peakInFlight, totals.inFlight);
		let failed = false;
		let code: string | null = null;
		let resultRows: number | null = null;
		try {
			const result = await execute();
			if (Array.isArray(result)) resultRows = result.length;
			return result;
		} catch (error: unknown) {
			failed = true;
			// Do not retain the error or copy its potentially sensitive message.
			if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^P\d{4}$/.test(error.code)) code = error.code;
			throw error;
		} finally {
			const now = this.clock();
			const durationMs = Math.round(Math.max(0, now - started));
			this.active.delete(token);
			this.inFlight--;
			totals.inFlight--;
			totals.completed++;
			totals.failed += Number(failed);
			totals.totalMs += durationMs;
			totals.maxMs = Math.max(totals.maxMs, durationMs);
			totals.maxResultRows = Math.max(totals.maxResultRows, resultRows ?? 0);
			const slow = durationMs >= this.slowMs;
			totals.slow += Number(slow);
			if (slow || failed) {
				const entry = { at: new Date().toISOString(), operation: key, durationMs, failed, code, resultRows };
				this.recent.push(entry);
				if (this.recent.length > MAX_RECENT) this.recent.shift();
				if (now - this.lastReport >= REPORT_INTERVAL_MS) {
					this.lastReport = now;
					const suppressed = this.suppressed;
					this.suppressed = 0;
					try { this.options.report?.({ ...entry, pid: process.pid, inFlight: this.inFlight, suppressed }); } catch { /* Diagnostics must not change query outcomes. */ }
				} else this.suppressed++;
			}
		}
	}

	snapshot() {
		const now = this.clock();
		return {
			enabled: this.enabled, slowMs: this.slowMs, inFlight: this.inFlight,
			untrackedInFlight: this.inFlight - this.active.size,
			active: Array.from(this.active.values(), (item) => ({ operation: item.operation, elapsedMs: Math.round(Math.max(0, now - item.started)) }))
				.sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 20),
			// Cumulative since process startup. Parallel durations can overlap.
			operations: Array.from(this.groups.values(), (item) => ({ ...item }))
				.sort((a, b) => b.inFlight - a.inFlight || b.totalMs - a.totalMs).slice(0, 20),
			recent: this.recent.map((item) => ({ ...item })),
		};
	}
}

export const databaseOperationMetrics = new DatabaseOperationMetrics({
	enabled: process.env["DATABASE_OPERATION_METRICS"] !== "false",
	slowMs: Number(process.env["DATABASE_SLOW_OPERATION_MS"] ?? 1_000),
	report: (entry) => { process.stderr.write(`[database-operation] ${JSON.stringify(entry)}\n`); },
});
