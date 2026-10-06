import fs from "node:fs";
import path from "node:path";
import { formatDigest, formatOpsAlert, formatOpsAlertTitle } from "./ops-alerts.format";
import type { OpsAlertInput, OpsAlertsConfig, OpsAlertType } from "./ops-alerts.types";

/** Output channels. Each call is fire-and-forget and must never raise another alert. */
export interface OpsAlertChannels {
	log(entry: Record<string, unknown>): void;
	notify(title: string, text: string): void;
	whatsapp(text: string): void;
}

interface KeyState {
	windowStart: number;
	lastSentAt: number;
	suppressed: number;
	last: OpsAlertInput;
	open: boolean;
	openedAt: number | null;
	reminders: number;
	lastReminderAt: number | null;
}

interface PersistedState {
	version: 1;
	keys: Record<string, KeyState>;
	sent: number[];
	overflow: Record<string, { type: OpsAlertType; instance: string; count: number }>;
	cursors: Record<string, number>;
	seen: string[];
}

export interface BufferedOpsAlert {
	key: string;
	at: string;
	alert: OpsAlertInput;
	dispatch: string;
}

const HOUR_MS = 60 * 60 * 1000;
const STALE_KEY_MS = 24 * HOUR_MS;
const MAX_SEEN = 500;
const PERSIST_DEBOUNCE_MS = 2_000;

export function opsAlertKey(alert: Pick<OpsAlertInput, "instance" | "type" | "clientId" | "sessionId">): string {
	return `${alert.instance}:${alert.type}:${alert.clientId || alert.sessionId || "-"}`;
}

function emptyState(): PersistedState {
	return { version: 1, keys: {}, sent: [], overflow: {}, cursors: {}, seen: [] };
}

/**
 * Central alert engine: dedup per key, global hourly cap with one digest,
 * reminders for open criticals, state persisted to a JSON file.
 * `emit` is synchronous, never throws and is never awaited by callers.
 */
export class OpsAlertsService {
	private state: PersistedState = emptyState();
	private readonly buffer: BufferedOpsAlert[] = [];
	private scope: Map<number, { instance: string }> | null = null;
	private tickTimer: NodeJS.Timeout | null = null;
	private persistTimer: NodeJS.Timeout | null = null;
	private persisting = false;
	private persistAgain = false;
	private loaded = false;
	private stopped = false;
	private writeSeq = 0;

	constructor(
		private readonly config: OpsAlertsConfig,
		private readonly channels: OpsAlertChannels,
		private readonly now: () => number = Date.now
	) {}

	public get enabled(): boolean {
		return this.config.enabled;
	}

	public start(): void {
		if (!this.config.enabled || this.tickTimer) return;
		this.stopped = false;
		this.loadState();
		this.tickTimer = setInterval(() => this.tick(), this.config.tickMs);
		this.tickTimer.unref();
	}

	public stop(): void {
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = null;
		if (this.persistTimer) clearTimeout(this.persistTimer);
		this.persistTimer = null;
		// An async persist still in flight must not rename over the final flush.
		this.stopped = true;
		this.flushStateSync();
	}

	/** Clients allowed to alert (active and connected recently). `null` = not loaded yet. */
	public setScope(scope: Map<number, { instance: string }> | null): void {
		this.scope = scope;
	}

	public isInScope(clientId: number | undefined): boolean {
		if (!clientId) return true;
		if (this.config.excludedClientIds.has(clientId)) return false;
		return this.scope === null || this.scope.has(clientId);
	}

	public isOpen(alert: Pick<OpsAlertInput, "instance" | "type" | "clientId" | "sessionId">): boolean {
		return this.state.keys[opsAlertKey(alert)]?.open === true;
	}

	public recent(): readonly BufferedOpsAlert[] {
		return this.buffer;
	}

	public getCursor(name: string): number | null {
		return this.state.cursors[name] ?? null;
	}

	public setCursor(name: string, value: number): void {
		this.state.cursors[name] = value;
		this.schedulePersist();
	}

	public clearCursor(name: string): void {
		if (!(name in this.state.cursors)) return;
		delete this.state.cursors[name];
		this.schedulePersist();
	}

	public cursorNames(prefix: string): string[] {
		return Object.keys(this.state.cursors).filter((name) => name.startsWith(prefix));
	}

	public hasSeen(id: string): boolean {
		return this.state.seen.includes(id);
	}

	public markSeen(id: string): void {
		if (this.state.seen.includes(id)) return;
		this.state.seen.push(id);
		if (this.state.seen.length > MAX_SEEN) this.state.seen.splice(0, this.state.seen.length - MAX_SEEN);
		this.schedulePersist();
	}

	public emit(alert: OpsAlertInput): void {
		try {
			this.handle(alert);
		} catch (error) {
			this.safeLog({ event: "emit-error", error: error instanceof Error ? error.message : String(error) });
		}
	}

	private handle(alert: OpsAlertInput): void {
		if (!this.config.enabled) return;
		const key = opsAlertKey(alert);
		const now = this.now();
		const current = this.state.keys[key];

		if (alert.severity === "resolved") {
			if (!current?.open) return;
			current.open = false;
			current.openedAt = null;
			current.reminders = 0;
			current.lastReminderAt = null;
			this.record(key, alert, "resolved");
			this.dispatch(key, alert, { bypassCap: true });
			this.schedulePersist();
			return;
		}
		if (!this.isInScope(alert.clientId)) return;

		// An open critical already notified; reminders, not repeats, keep it visible.
		if (current?.open && alert.severity === "critical") {
			current.last = alert;
			this.record(key, alert, "open");
			return;
		}

		const critical = alert.severity === "critical";
		// A critical that is not open (new or after RESOLVED) is a new incident.
		if (!current || critical || now - current.windowStart >= this.config.dedupWindowMs) {
			const folded = current?.suppressed ?? 0;
			this.state.keys[key] = {
				windowStart: now,
				lastSentAt: now,
				suppressed: 0,
				last: alert,
				open: critical || (current?.open ?? false),
				openedAt: critical ? now : (current?.openedAt ?? null),
				reminders: 0,
				lastReminderAt: null
			};
			const sent = this.dispatch(key, alert, { suppressed: folded });
			this.record(key, alert, sent ? "sent" : "overflow");
		} else {
			current.suppressed += 1;
			current.last = alert;
			this.record(key, alert, "suppressed");
		}
		this.schedulePersist();
	}

	/** Flushes expired dedup windows, sends reminders and the overflow digest. */
	public tick(): void {
		try {
			if (!this.config.enabled) return;
			const now = this.now();
			for (const [key, entry] of Object.entries(this.state.keys)) {
				if (entry.suppressed > 0 && now - entry.windowStart >= this.config.dedupWindowMs) {
					const suppressed = entry.suppressed;
					entry.windowStart = now;
					entry.suppressed = 0;
					entry.lastSentAt = now;
					this.dispatch(key, entry.last, { suppressed, summaryOnly: true });
				}
				if (
					entry.open &&
					entry.openedAt !== null &&
					entry.reminders < this.config.maxReminders &&
					now - (entry.lastReminderAt ?? entry.openedAt) >= this.config.reminderMs
				) {
					entry.reminders += 1;
					entry.lastReminderAt = now;
					this.dispatch(key, entry.last, { reminder: { index: entry.reminders, max: this.config.maxReminders } });
				}
				if (!entry.open && entry.suppressed === 0 && now - entry.windowStart > STALE_KEY_MS) {
					delete this.state.keys[key];
				}
			}
			this.pruneSent(now);
			const overflow = Object.values(this.state.overflow);
			if (overflow.length && this.state.sent.length < this.config.maxPerHour) {
				const text = formatDigest(overflow, { now: new Date(now), maxPerHour: this.config.maxPerHour });
				this.state.overflow = {};
				this.state.sent.push(now);
				this.deliver("digest", text.split("\n")[0] || "[RESUMO]", text, { kind: "digest" });
			}
			this.schedulePersist();
		} catch (error) {
			this.safeLog({ event: "tick-error", error: error instanceof Error ? error.message : String(error) });
		}
	}

	private dispatch(
		key: string,
		alert: OpsAlertInput,
		options: {
			suppressed?: number;
			bypassCap?: boolean;
			summaryOnly?: boolean;
			reminder?: { index: number; max: number };
		}
	): boolean {
		const now = this.now();
		this.pruneSent(now);
		if (!options.bypassCap && this.state.sent.length >= this.config.maxPerHour) {
			const overflowKey = `${alert.type}:${alert.instance}`;
			const entry = this.state.overflow[overflowKey] || { type: alert.type, instance: alert.instance, count: 0 };
			entry.count += Math.max(1, options.suppressed ?? 1);
			this.state.overflow[overflowKey] = entry;
			return false;
		}
		this.state.sent.push(now);
		const text = formatOpsAlert(alert, {
			now: new Date(now),
			slowSendMs: this.config.slowSendMs,
			dedupWindowMs: this.config.dedupWindowMs,
			...(options.suppressed ? { suppressed: options.suppressed } : {}),
			...(options.reminder ? { reminder: options.reminder } : {})
		});
		const kind = alert.severity === "resolved"
			? "resolved"
			: options.reminder
				? "reminder"
				: options.summaryOnly
					? "summary"
					: "alert";
		this.deliver(key, formatOpsAlertTitle(alert, this.config.slowSendMs), text, {
			kind,
			type: alert.type,
			severity: alert.severity,
			instance: alert.instance,
			clientId: alert.clientId ?? null,
			sessionId: alert.sessionId ?? null,
			refs: alert.refs ?? {},
			suppressed: options.suppressed ?? 0
		});
		return true;
	}

	private deliver(key: string, title: string, text: string, details: Record<string, unknown>): void {
		this.safeLog({ event: "dispatch", key, ...details, text });
		try {
			this.channels.notify(title.slice(0, 191), text);
		} catch {
			// Alert channels never raise further alerts.
		}
		try {
			this.channels.whatsapp(text);
		} catch {
			// Alert channels never raise further alerts.
		}
	}

	private record(key: string, alert: OpsAlertInput, dispatch: string): void {
		this.buffer.push({ key, at: new Date(this.now()).toISOString(), alert, dispatch });
		if (this.buffer.length > this.config.bufferSize) this.buffer.splice(0, this.buffer.length - this.config.bufferSize);
		if (dispatch !== "sent" && dispatch !== "resolved") {
			this.safeLog({
				event: dispatch,
				key,
				type: alert.type,
				severity: alert.severity,
				instance: alert.instance,
				clientId: alert.clientId ?? null,
				refs: alert.refs ?? {}
			});
		}
	}

	private pruneSent(now: number): void {
		this.state.sent = this.state.sent.filter((at) => now - at < HOUR_MS);
	}

	private safeLog(entry: Record<string, unknown>): void {
		try {
			this.channels.log(entry);
		} catch {
			// Logging must not break the caller.
		}
	}

	// ─── State file ────────────────────────────────────────────────────────────

	public loadState(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = fs.readFileSync(this.config.stateFile, "utf8");
			const parsed = JSON.parse(raw) as Partial<PersistedState>;
			if (!parsed || typeof parsed !== "object" || parsed.version !== 1) throw new Error("unsupported state");
			this.state = {
				version: 1,
				keys: parsed.keys && typeof parsed.keys === "object" ? parsed.keys : {},
				sent: Array.isArray(parsed.sent) ? parsed.sent.filter((value) => typeof value === "number") : [],
				overflow: parsed.overflow && typeof parsed.overflow === "object" ? parsed.overflow : {},
				cursors: parsed.cursors && typeof parsed.cursors === "object" ? parsed.cursors : {},
				seen: Array.isArray(parsed.seen) ? parsed.seen.filter((value) => typeof value === "string").slice(-MAX_SEEN) : []
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT") this.safeLog({ event: "state-ignored", reason: error instanceof Error ? error.message : String(error) });
			this.state = emptyState();
		}
	}

	private serialize(): string {
		return JSON.stringify(this.state);
	}

	private schedulePersist(): void {
		if (!this.tickTimer || this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.persist();
		}, PERSIST_DEBOUNCE_MS);
		this.persistTimer.unref();
	}

	public async persist(): Promise<void> {
		if (this.persisting) {
			this.persistAgain = true;
			return;
		}
		this.persisting = true;
		try {
			const file = this.config.stateFile;
			const temp = this.tempFile(file);
			await fs.promises.mkdir(path.dirname(file), { recursive: true });
			await fs.promises.writeFile(temp, this.serialize(), "utf8");
			if (this.stopped) {
				await fs.promises.unlink(temp).catch(() => undefined);
				return;
			}
			await fs.promises.rename(temp, file);
		} catch (error) {
			this.safeLog({ event: "state-write-failed", reason: error instanceof Error ? error.message : String(error) });
		} finally {
			this.persisting = false;
			if (this.persistAgain) {
				this.persistAgain = false;
				void this.persist();
			}
		}
	}

	/** Every write gets its own temp file, so a sync flush never shares one with an async persist. */
	private tempFile(file: string): string {
		this.writeSeq += 1;
		return `${file}.${process.pid}.${this.writeSeq}.tmp`;
	}

	private flushStateSync(): void {
		if (!this.loaded) return;
		try {
			const file = this.config.stateFile;
			const temp = this.tempFile(file);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(temp, this.serialize(), "utf8");
			fs.renameSync(temp, file);
		} catch (error) {
			this.safeLog({ event: "state-write-failed", reason: error instanceof Error ? error.message : String(error) });
		}
	}
}
