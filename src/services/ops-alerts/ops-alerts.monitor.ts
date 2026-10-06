import type prismaService from "../prisma.service";
import { parseQueuePayload } from "../../utils/internal-wpp-send-outcome";
import { formatSeconds } from "./ops-alerts.format";
import type { OpsAlertsService } from "./ops-alerts.service";
import type { OpsAlertInput, OpsAlertsConfig } from "./ops-alerts.types";

type Db = Pick<
	typeof prismaService,
	"wppClient" | "wppClientSessionEvent" | "internalMessageProcessingQueue" | "operatorOutboundSend"
>;

const OPERATOR_CURSOR = "operator-terminal";
const SESSION_DOWN_CURSOR = "session-down:";
const CONDITION_CURSOR = "condition:";
const OPERATOR_SCAN_PAGE = 100;
const OPERATOR_SCAN_MAX_PAGES = 5;
const OPERATOR_SCAN_OVERLAP_MS = 5_000;
const OPERATOR_SCAN_MAX_LOOKBACK_MS = 60 * 60 * 1000;
const UNREACHABLE_POLL_FAILURES = 3;
const AUTH_STATES = new Set(["QR_PENDING", "LOGGED_OUT"]);

interface ScopedClient {
	id: number;
	instance: string;
	snapshot: {
		state: string;
		stateChangedAt: Date;
		lastConnectedAt: Date | null;
		lastDisconnectedAt: Date | null;
		lastObservedAt: Date;
		consecutivePollFailures: number;
	};
}

interface OperatorTerminalRow {
	id: string;
	instance: string;
	clientId: number;
	messageId: number;
	remoteJobId: string | null;
	status: string;
	createdAt: Date;
	completedAt: Date | null;
}

/** Periodic database checks feeding the ops alerts (session, storm, backlog, operator outcomes). */
export class OpsAlertsMonitor {
	private checkTimer: NodeJS.Timeout | null = null;
	private stormTimer: NodeJS.Timeout | null = null;
	private running = false;
	private clients: ScopedClient[] = [];

	constructor(
		private readonly alerts: OpsAlertsService,
		private readonly config: OpsAlertsConfig,
		private readonly db: Db,
		private readonly log: (message: string) => void,
		private readonly now: () => number = Date.now
	) {}

	public start(): void {
		if (!this.config.enabled || this.checkTimer) return;
		this.checkTimer = setInterval(() => void this.runChecks(), this.config.checkIntervalMs);
		this.checkTimer.unref();
		this.stormTimer = setInterval(() => void this.checkDisconnectStorm().catch((error) => this.fail("storm", error)), this.config.stormCheckMs);
		this.stormTimer.unref();
		void this.runChecks();
	}

	public stop(): void {
		if (this.checkTimer) clearInterval(this.checkTimer);
		if (this.stormTimer) clearInterval(this.stormTimer);
		this.checkTimer = null;
		this.stormTimer = null;
	}

	public async runChecks(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await this.refreshScope();
			for (const [name, check] of [
				["sessions", () => this.checkSessions()],
				["backlog", () => this.checkBacklog()],
				["operator", () => this.scanOperatorOutcomes()]
			] as const) {
				await check().catch((error) => this.fail(name, error));
			}
		} catch (error) {
			this.fail("scope", error);
		} finally {
			this.running = false;
		}
	}

	private fail(check: string, error: unknown): void {
		this.log(`[ops-alert] check ${check} failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	/** Only active REMOTE clients that were CONNECTED in the scope window can alert. */
	public async refreshScope(): Promise<void> {
		const rows = await this.db.wppClient.findMany({
			where: { type: "REMOTE", isActive: true },
			select: {
				id: true,
				instance: true,
				sessionSnapshot: {
					select: {
						state: true,
						stateChangedAt: true,
						lastConnectedAt: true,
						lastDisconnectedAt: true,
						lastObservedAt: true,
						consecutivePollFailures: true
					}
				}
			}
		});
		const since = this.now() - this.config.scopeWindowMs;
		const candidates: ScopedClient[] = [];
		for (const row of rows) {
			if (!row.sessionSnapshot || this.config.excludedClientIds.has(row.id)) continue;
			candidates.push({ id: row.id, instance: row.instance, snapshot: row.sessionSnapshot });
		}
		const connected = new Set(
			candidates
				.filter(
					({ snapshot }) => snapshot.state === "CONNECTED" || (snapshot.lastConnectedAt?.getTime() ?? 0) >= since
				)
				.map((client) => client.id)
		);
		// `lastConnectedAt` lives in the wwebjs-api process memory: after a restart it is
		// null, exactly when a session that did not come back matters most. A persisted
		// transition to or from CONNECTED in the window proves a recent connection instead.
		const unproven = candidates.filter((client) => !connected.has(client.id)).map((client) => client.id);
		if (unproven.length) {
			const events = await this.db.wppClientSessionEvent.groupBy({
				by: ["clientId"],
				where: {
					clientId: { in: unproven },
					occurredAt: { gte: new Date(since) },
					OR: [{ state: "CONNECTED" }, { previousState: "CONNECTED" }]
				},
				_count: { _all: true }
			});
			for (const event of events) connected.add(event.clientId);
		}
		const clients = candidates.filter((client) => connected.has(client.id));
		this.clients = clients;
		this.alerts.setScope(new Map(clients.map((client) => [client.id, { instance: client.instance }])));
	}

	/** PRIMARY not CONNECTED for too long (snapshot is PRIMARY-first, see remote-session-directory). */
	public async checkSessions(): Promise<void> {
		const now = this.now();
		for (const client of this.clients) {
			const { snapshot } = client;
			const key = { type: "SESSION_DOWN" as const, instance: client.instance, clientId: client.id };
			const unreachable =
				snapshot.consecutivePollFailures >= UNREACHABLE_POLL_FAILURES &&
				now - snapshot.lastObservedAt.getTime() > this.config.sessionDownMs;

			if (snapshot.state === "CONNECTED" && !unreachable) {
				this.alerts.clearCursor(`${SESSION_DOWN_CURSOR}${client.id}`);
				if (this.alerts.isOpen(key)) {
					this.alerts.emit({ ...key, severity: "resolved", summary: "Sessão conectada novamente" });
				}
				continue;
			}

			if (unreachable) {
				this.alerts.emit({
					...key,
					severity: "critical",
					summary: `API do WhatsApp sem resposta há ${formatSeconds(now - snapshot.lastObservedAt.getTime())}`,
					refs: { state: "UNREACHABLE", since: snapshot.lastObservedAt.toISOString() }
				});
				continue;
			}

			const disconnectedAt = snapshot.lastDisconnectedAt?.getTime() ?? 0;
			const connectedAt = snapshot.lastConnectedAt?.getTime() ?? 0;
			const observed = disconnectedAt && disconnectedAt >= connectedAt ? disconnectedAt : snapshot.stateChangedAt.getTime();
			const downSince = this.outageStart(client.id, observed, connectedAt);
			const threshold = AUTH_STATES.has(snapshot.state) ? this.config.sessionAuthDownMs : this.config.sessionDownMs;
			if (now - downSince <= threshold) continue;
			this.alerts.emit({
				...key,
				severity: "critical",
				summary: `Estado ${snapshot.state} há ${formatSeconds(now - downSince)}`,
				refs: { state: snapshot.state, since: new Date(downSince).toISOString() }
			});
		}
		const scoped = new Set(this.clients.map((client) => `${SESSION_DOWN_CURSOR}${client.id}`));
		for (const name of this.alerts.cursorNames(SESSION_DOWN_CURSOR)) {
			if (!scoped.has(name)) this.alerts.clearCursor(name);
		}
	}

	/**
	 * Start of the current outage. wwebjs-api moves `lastDisconnectedAt` on EVERY failed
	 * reconnect (Baileys retries every ~5 s), so the snapshot alone would restart the clock
	 * forever. The earliest start seen is kept (persisted) until the session connects again.
	 */
	private outageStart(clientId: number, observed: number, lastConnectedAt: number): number {
		const name = `${SESSION_DOWN_CURSOR}${clientId}`;
		const tracked = this.alerts.getCursor(name);
		const since = tracked !== null && tracked > lastConnectedAt ? Math.min(tracked, observed) : observed;
		if (since !== tracked) this.alerts.setCursor(name, since);
		return since;
	}

	/**
	 * Level-triggered checks (storm, backlog) alert when a condition starts, not on every
	 * re-check: a re-check is not a new occurrence. A condition that clears and comes back
	 * alerts again.
	 */
	private syncConditions(kind: string, active: Map<string, OpsAlertInput>): void {
		const prefix = `${CONDITION_CURSOR}${kind}:`;
		for (const [id, alert] of active) {
			const name = `${prefix}${id}`;
			if (this.alerts.getCursor(name) !== null) continue;
			this.alerts.setCursor(name, this.now());
			this.alerts.emit(alert);
		}
		for (const name of this.alerts.cursorNames(prefix)) {
			if (!active.has(name.slice(prefix.length))) this.alerts.clearCursor(name);
		}
	}

	public async checkDisconnectStorm(): Promise<void> {
		const active = new Map<string, OpsAlertInput>();
		if (!this.clients.length) return this.syncConditions("storm", active);
		const since = new Date(this.now() - 60 * 60 * 1000);
		const groups = await this.db.wppClientSessionEvent.groupBy({
			by: ["clientId"],
			where: { clientId: { in: this.clients.map((client) => client.id) }, state: "DISCONNECTED", occurredAt: { gte: since } },
			_count: { _all: true }
		});
		for (const group of groups) {
			const count = group._count._all;
			const client = this.clients.find((item) => item.id === group.clientId);
			if (!client || count <= this.config.disconnectStormThreshold) continue;
			active.set(String(client.id), {
				type: "DISCONNECT_STORM",
				severity: "warn",
				instance: client.instance,
				clientId: client.id,
				summary: `${count} desconexões na última hora`,
				refs: { count }
			});
		}
		this.syncConditions("storm", active);
	}

	/** Internal group queue and operator outbound items still open after the backlog threshold. */
	public async checkBacklog(): Promise<void> {
		const now = this.now();
		const cutoff = new Date(now - this.config.backlogMs);
		const backlog = new Map<string, { instance: string; clientId: number | undefined; queue: "internal" | "operator"; count: number; oldest: number }>();
		const add = (instance: string, clientId: number | undefined, queue: "internal" | "operator", startedAt: number, count = 1) => {
			const key = `${instance}:${clientId ?? "-"}:${queue}`;
			const entry = backlog.get(key) || { instance, clientId, queue, count: 0, oldest: startedAt };
			entry.count += count;
			entry.oldest = Math.min(entry.oldest, startedAt);
			backlog.set(key, entry);
		};

		const internal = await this.db.internalMessageProcessingQueue.findMany({
			where: { status: { in: ["PENDING", "PROCESSING"] }, createdAt: { lt: cutoff } },
			select: { instance: true, createdAt: true, messageData: true },
			orderBy: { createdAt: "asc" },
			take: 200
		});
		for (const row of internal) {
			const payload = parseQueuePayload<{ clientId?: number; lastRetryAt?: string; timing?: { slowAlertedAt?: string } }>(
				row.messageData
			);
			// Already reported as SEND_SLOW: claimed and waiting on the remote job or receipt window.
			if (payload?.timing?.slowAlertedAt) continue;
			// A manual resend restarts the clock; createdAt keeps the original time.
			const retriedAt = payload?.lastRetryAt ? new Date(payload.lastRetryAt).getTime() : Number.NaN;
			const startedAt = Number.isNaN(retriedAt) ? row.createdAt.getTime() : Math.max(retriedAt, row.createdAt.getTime());
			if (now - startedAt <= this.config.backlogMs) continue;
			add(row.instance, typeof payload?.clientId === "number" ? payload.clientId : undefined, "internal", startedAt);
		}

		const operator = await this.db.operatorOutboundSend.groupBy({
			by: ["instance", "clientId"],
			where: { status: { in: ["PENDING", "PROCESSING"] }, createdAt: { lt: cutoff } },
			_count: { _all: true },
			_min: { createdAt: true }
		});
		for (const group of operator) {
			add(group.instance, group.clientId, "operator", group._min.createdAt?.getTime() ?? now, group._count._all);
		}

		const active = new Map<string, OpsAlertInput>();
		for (const [id, entry] of backlog) {
			active.set(id, {
				type: "QUEUE_BACKLOG",
				severity: "warn",
				instance: entry.instance,
				clientId: entry.clientId,
				summary: `${entry.count} envio(s) ${entry.queue === "internal" ? "de grupo interno" : "de operador"} aguardando há mais de ${formatSeconds(now - entry.oldest)}`,
				refs: { queue: entry.queue, count: entry.count, since: new Date(entry.oldest).toISOString() }
			});
		}
		this.syncConditions("backlog", active);
	}

	/** Operator REMOTE sends that ended UNKNOWN/FAILED since the last scan. */
	public async scanOperatorOutcomes(): Promise<void> {
		const now = this.now();
		const stored = this.alerts.getCursor(OPERATOR_CURSOR);
		if (stored === null) {
			// First run: historical rows are not alerted.
			this.alerts.setCursor(OPERATOR_CURSOR, now);
			return;
		}
		const since = new Date(Math.max(stored, now - OPERATOR_SCAN_MAX_LOOKBACK_MS) - OPERATOR_SCAN_OVERLAP_MS);
		let lastCompletedAt: number | null = null;
		let truncated = false;
		for (let page = 0; page < OPERATOR_SCAN_MAX_PAGES; page += 1) {
			const rows: OperatorTerminalRow[] = await this.db.operatorOutboundSend.findMany({
				// next_attempt_at >= completed_at for terminal rows, so it narrows the indexed range.
				where: {
					status: { in: ["FAILED", "UNKNOWN"] },
					deliveryMode: "REMOTE",
					nextAttemptAt: { gte: since },
					completedAt: { gte: since }
				},
				select: { id: true, instance: true, clientId: true, messageId: true, remoteJobId: true, status: true, createdAt: true, completedAt: true },
				orderBy: [{ completedAt: "asc" }, { id: "asc" }],
				skip: page * OPERATOR_SCAN_PAGE,
				take: OPERATOR_SCAN_PAGE
			});
			this.alertOperatorRows(rows, now);
			const last = rows.at(-1)?.completedAt;
			if (last) lastCompletedAt = last.getTime();
			truncated = rows.length === OPERATOR_SCAN_PAGE;
			if (!truncated) break;
		}
		// A burst larger than the pages read resumes from the last row read; seen ids skip repeats.
		this.alerts.setCursor(OPERATOR_CURSOR, truncated && lastCompletedAt !== null ? lastCompletedAt : now);
	}

	private alertOperatorRows(rows: OperatorTerminalRow[], now: number): void {
		for (const row of rows) {
			if (this.alerts.hasSeen(row.id)) continue;
			this.alerts.markSeen(row.id);
			this.alerts.emit({
				type: "SEND_FAILED",
				severity: "high",
				instance: row.instance,
				clientId: row.clientId,
				summary:
					row.status === "FAILED"
						? "Envio de operador falhou (confirmado pelo provedor)"
						: "Envio de operador sem confirmação (resultado incerto)",
				refs: {
					messageId: row.messageId,
					jobId: row.remoteJobId ?? undefined,
					outcome: row.status,
					durationMs: (row.completedAt?.getTime() ?? now) - row.createdAt.getTime()
				}
			});
		}
	}
}
