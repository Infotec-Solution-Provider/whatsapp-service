import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { captureDatabaseIncident } from "./database-incident-capture";

export interface DatabaseIncidentContext {
	source: string;
	operation?: string;
}

type ErrorLike = { code?: unknown; message?: unknown; cause?: unknown };

const REPEAT_WINDOW_MS = 5_000;
const MAX_MESSAGE_LENGTH = 1_200;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const recent = new Map<string, number>();
let pendingWrite = Promise.resolve();
let fileLimitReported = false;

function errorChain(error: unknown): ErrorLike[] {
	const entries: ErrorLike[] = [];
	const seen = new Set<unknown>();
	let current = error;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		entries.push(current as ErrorLike);
		current = (current as ErrorLike).cause;
	}
	return entries;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function redact(value: string): string {
	return value
		.replace(/(?:mysql|postgres(?:ql)?):\/\/\S+/gi, "[database-url-redacted]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_MESSAGE_LENGTH);
}

export function databaseIncidentDetails(error: unknown): { code: string | null; message: string } | null {
	const entries = errorChain(error);
	const codes = entries.map((entry) => text(entry.code)).filter(Boolean);
	const messages = entries.map((entry) => text(entry.message)).filter(Boolean);
	const rawMessage = messages.join(" | ");
	const code = codes.find((value) => /^P(?:1000|1001|1002|1008|1017|2024|2028|2037)$/i.test(value))
		?? rawMessage.match(/\bP(?:1000|1001|1002|1008|1017|2024|2028|2037)\b/i)?.[0]
		?? (/Timed out fetching a new connection from the connection pool/i.test(rawMessage) ? "P2024" : null)
		?? (/Transaction API error:.*Transaction already closed/is.test(rawMessage) ? "P2028" : null)
		?? null;
	const message = redact(rawMessage);
	const databaseFailure =
		code !== null ||
		/\bP(?:1000|1001|1002|1008|1017|2024|2028|2037)\b/i.test(message) ||
		/(connection pool|database server|too many connections|mysql.*(?:timeout|refused|lost|reset)|prisma.*(?:timeout|connection))/i.test(message);
	return databaseFailure ? { code, message: message || "Database incident without an error message." } : null;
}

function logPath(): string {
	const configured = process.env["DATABASE_INCIDENT_LOG_PATH"]?.trim();
	return resolve(process.cwd(), configured || "logs/database-incidents.log");
}

function maxFileBytes(): number {
	const value = Number(process.env["DATABASE_INCIDENT_LOG_MAX_BYTES"]);
	return Number.isSafeInteger(value) && value >= 1_024 ? value : DEFAULT_MAX_FILE_BYTES;
}

function writeStderr(line: string): void {
	try {
		process.stderr.write(`[database-incident] ${line}\n`);
	} catch {
		// stderr can be unavailable while the process is terminating.
	}
}

function queueFileWrite(line: string): void {
	const path = logPath();
	pendingWrite = pendingWrite
		.catch(() => undefined)
		.then(async () => {
			await mkdir(dirname(path), { recursive: true });
			try {
				if ((await stat(path)).size >= maxFileBytes()) {
					if (!fileLimitReported) {
						fileLimitReported = true;
						writeStderr(JSON.stringify({
							at: new Date().toISOString(), source: "database-incident-file", error: "file_size_limit_reached",
						}));
					}
					return;
				}
			} catch (error: unknown) {
				if ((error as { code?: unknown }).code !== "ENOENT") throw error;
			}
			await appendFile(path, `${line}\n`, "utf8");
		})
		.catch((error: unknown) => {
			writeStderr(JSON.stringify({
				at: new Date().toISOString(),
				source: "database-incident-file",
				error: redact(error instanceof Error ? error.message : String(error)),
			}));
		});
}

/** Resolves after queued local incident writes; useful for a controlled shutdown. */
export function flushDatabaseIncidentLog(): Promise<void> {
	return pendingWrite.catch(() => undefined);
}

/**
 * Persists database-pool incidents without using Prisma. stderr is also used so
 * PM2 retains the event even when the service directory is not persistent.
 */
export function recordDatabaseIncident(error: unknown, context: DatabaseIncidentContext): boolean {
	const details = databaseIncidentDetails(error);
	if (!details) return false;
	captureDatabaseIncident({ code: details.code, source: context.source });
	const now = Date.now();
	const fingerprint = `${context.source}|${context.operation ?? ""}|${details.code ?? ""}|${details.message}`;
	const previous = recent.get(fingerprint);
	if (previous !== undefined && now - previous < REPEAT_WINDOW_MS) return true;
	recent.set(fingerprint, now);
	if (recent.size > 256) {
		for (const [key, at] of recent) {
			if (now - at > REPEAT_WINDOW_MS) recent.delete(key);
		}
	}
	const memory = process.memoryUsage();
	const line = JSON.stringify({
		at: new Date(now).toISOString(),
		pid: process.pid,
		uptimeSeconds: Math.round(process.uptime()),
		source: context.source,
		...(context.operation ? { operation: redact(context.operation) } : {}),
		code: details.code,
		message: details.message,
		memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
	});
	writeStderr(line);
	queueFileWrite(line);
	return true;
}
