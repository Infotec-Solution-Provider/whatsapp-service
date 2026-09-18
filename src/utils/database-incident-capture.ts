import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const SAMPLE_MS = 5_000;
const HISTORY_SAMPLES = 60;
const COOLDOWN_MS = 5 * 60_000;
const MAX_FILES = 5;
const MAX_OUTPUT_BYTES = 512 * 1024;

interface CaptureTrigger { code: string | null; source: string }
interface CollectorResult { output: string; failed: boolean }
interface CaptureOptions {
	directory: string;
	pm2Id: string;
	runCollector: () => Promise<CollectorResult>;
	report: (entry: Record<string, unknown>) => void;
	clock?: () => number;
}

function validPm2Id(value: string): boolean {
	return /^\d{1,7}$/.test(value) && Number(value) <= 1_000_000;
}

/** Bounded runtime history; database/PM2 queries run only after an incident. */
export class DatabaseIncidentCapture {
	private readonly history: Record<string, unknown>[] = [];
	private readonly clock: () => number;
	private lastSample: number;
	private lastCpu = process.cpuUsage();
	private lastCapture = -Infinity;
	private running = false;
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly options: CaptureOptions) {
		if (!validPm2Id(options.pm2Id)) throw new Error("invalid_pm2_id");
		this.clock = options.clock ?? (() => performance.now());
		this.lastSample = this.clock();
	}

	start(): void {
		if (this.timer) return;
		this.sampleRuntime();
		this.timer = setInterval(() => this.sampleRuntime(), SAMPLE_MS);
		this.timer.unref();
	}

	stop(): void { clearInterval(this.timer); this.timer = undefined; }

	sampleRuntime(): void {
		const now = this.clock();
		const elapsedMs = Math.max(0, now - this.lastSample);
		const cpu = process.cpuUsage();
		const cpuMicros = cpu.user + cpu.system - this.lastCpu.user - this.lastCpu.system;
		this.history.push({
			at: new Date().toISOString(), intervalMs: elapsedMs,
			timerDelayMs: Math.max(0, elapsedMs - SAMPLE_MS),
			cpuPercent: elapsedMs > 0 ? cpuMicros / (elapsedMs * 10) : null,
			memory: process.memoryUsage(),
		});
		if (this.history.length > HISTORY_SAMPLES) this.history.shift();
		this.lastSample = now;
		this.lastCpu = cpu;
	}

	async capture(trigger: CaptureTrigger): Promise<void> {
		const now = this.clock();
		if (this.running || now - this.lastCapture < COOLDOWN_MS) return;
		this.running = true;
		this.lastCapture = now;
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			// Freeze the trigger before filesystem awaits allow timers to run again.
			const header = JSON.stringify({
				type: "trigger", at: new Date().toISOString(), pid: process.pid,
				pm2Id: this.options.pm2Id, code: trigger.code, source: trigger.source.slice(0, 120),
				history: this.history.slice(),
				current: { memory: process.memoryUsage(), timeSinceLastSampleMs: now - this.lastSample },
			});
			const directory = resolve(this.options.directory);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			// Only this collector's files for this PM2 slot participate in retention.
			const pattern = new RegExp(`^incident-${this.options.pm2Id}-\\d{13}-[a-f0-9-]{36}\\.jsonl$`);
			const files = (await readdir(directory, { withFileTypes: true }))
				.filter((entry) => entry.isFile() && pattern.test(entry.name))
				.map((entry) => entry.name).sort();
			for (const name of files.slice(0, Math.max(0, files.length - MAX_FILES + 1))) {
				await unlink(join(directory, name));
			}
			const path = join(directory, `incident-${this.options.pm2Id}-${Date.now()}-${randomUUID()}.jsonl`);
			file = await open(path, "wx", 0o600);
			// Persist history first: a subsequent restart must not discard it.
			await file.writeFile(header + "\n");
			this.report({ event: "started", path });
			const result = await this.options.runCollector();
			// Keep complete JSONL records when output is cut off by a timeout/limit.
			const output = Buffer.from(result.output).subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
			await file.writeFile(output.slice(0, output.lastIndexOf("\n") + 1));
			await file.writeFile(JSON.stringify({ type: "capture_end", failed: result.failed }) + "\n");
			this.report({ event: result.failed ? "collector_failed" : "completed", path });
		} catch {
			// Never log child stderr/raw exceptions (may contain environment data).
			this.report({ event: "capture_failed" });
		} finally {
			await file?.close().catch(() => undefined);
			this.running = false;
		}
	}

	private report(entry: Record<string, unknown>): void {
		try { this.options.report(entry); } catch { /* Diagnostics cannot break sending. */ }
	}
}

export function automaticCaptureEnabled(platform: string, env: NodeJS.ProcessEnv): boolean {
	return platform === "linux" && env["DATABASE_INCIDENT_AUTO_CAPTURE"] !== "false"
		&& validPm2Id(env["pm_id"] ?? "");
}

let automaticCapture: DatabaseIncidentCapture | undefined;

export function startDatabaseIncidentCapture(): void {
	if (automaticCapture || !automaticCaptureEnabled(process.platform, process.env)) return;
	const pm2Id = process.env["pm_id"]!;
	automaticCapture = new DatabaseIncidentCapture({
		directory: resolve(process.env["DATABASE_INCIDENT_CAPTURE_DIR"] || "logs/database-incidents"),
		pm2Id,
		report: (entry) => process.stderr.write(`[database-incident-capture] ${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`),
		runCollector: () => new Promise((done) => {
			execFile(process.execPath, [resolve(__dirname, "../../scripts/capture-resource-incident.cjs"),
				"--pm2-id", pm2Id, "--samples", "3", "--interval-ms", "2000", "--db"],
			{ timeout: 60_000, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
			(error, stdout) => done({ output: stdout, failed: !!error }));
		}),
	});
	automaticCapture.start();
}

export function captureDatabaseIncident(trigger: CaptureTrigger): void {
	// The Prisma singleton starts history collection; no work is awaited by callers.
	void automaticCapture?.capture(trigger);
}
