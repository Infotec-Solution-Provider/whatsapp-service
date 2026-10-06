import { randomUUID } from "node:crypto";
import type { OpsAlertsConfig } from "./ops-alerts.types";
import { pickClientSession } from "../../utils/remote-session-directory";

export interface AlertSenderHttp {
	get<T>(url: string, options: { timeout: number }): Promise<{ data: T }>;
	post<T>(url: string, body: unknown, options: { timeout: number; headers: Record<string, string> }): Promise<{ data: T }>;
}

type SenderConfig = Pick<
	OpsAlertsConfig,
	| "whatsappMode"
	| "senderUrl"
	| "whatsappTo"
	| "senderTimeoutMs"
	| "senderHealthTtlMs"
	| "senderFailureThreshold"
	| "senderBackoffMs"
	| "senderUnavailableLogMs"
>;

interface SessionListItem {
	sessionId: string;
	monitorRole?: string | null;
	isDefault?: boolean;
	available?: boolean;
}

/**
 * Sends alert texts through the dedicated Infotec wwebjs-api process (never a
 * tenant client). Fire-and-forget; failures only open a circuit breaker.
 */
export class WhatsappAlertSender {
	private health: { healthy: boolean; at: number } | null = null;
	private healthCheck: Promise<boolean> | null = null;
	private consecutiveFailures = 0;
	private openUntil = 0;
	private lastUnavailableLogAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly config: SenderConfig,
		private readonly http: AlertSenderHttp,
		private readonly log: (message: string) => void,
		private readonly now: () => number = Date.now
	) {}

	public send(text: string): void {
		if (this.config.whatsappMode === "off") return;
		void this.deliver(text).catch(() => undefined);
	}

	/** Exposed for tests: resolves when the attempt is finished. */
	public async deliver(text: string): Promise<"sent" | "skipped" | "failed"> {
		const now = this.now();
		if (this.config.whatsappMode === "off") return "skipped";
		if (now < this.openUntil) return "skipped";
		if (this.config.whatsappMode === "auto" && !(await this.isHealthy())) {
			if (now - this.lastUnavailableLogAt >= this.config.senderUnavailableLogMs) {
				this.lastUnavailableLogAt = now;
				this.log(`[ops-alert] sender unavailable (${this.config.senderUrl}); WhatsApp channel skipped`);
			}
			return "skipped";
		}
		try {
			const response = await this.http.post<{ jobId?: string; status?: string }>(
				`${this.config.senderUrl}/api/send-message/jobs`,
				{ to: this.config.whatsappTo, text },
				{ timeout: this.config.senderTimeoutMs, headers: { "Idempotency-Key": `ops-alert:${randomUUID()}` } }
			);
			this.consecutiveFailures = 0;
			this.log(`[ops-alert] whatsapp job ${response.data?.jobId ?? "?"} status=${response.data?.status ?? "?"}`);
			return "sent";
		} catch (error) {
			this.consecutiveFailures += 1;
			this.health = null;
			const reason = (error as { code?: string; response?: { status?: number } })?.response?.status
				? `HTTP ${(error as { response: { status: number } }).response.status}`
				: (error as { code?: string })?.code || "error";
			if (this.consecutiveFailures >= this.config.senderFailureThreshold) {
				this.openUntil = this.now() + this.config.senderBackoffMs;
				this.consecutiveFailures = 0;
				this.log(
					`[ops-alert] whatsapp sender failed ${this.config.senderFailureThreshold}x (${reason}); backing off ${Math.round(this.config.senderBackoffMs / 60_000)} min`
				);
			} else {
				this.log(`[ops-alert] whatsapp send failed (${reason})`);
			}
			return "failed";
		}
	}

	/** Reachable and the chosen session's WhatsApp state is CONNECTED (cached). */
	public async isHealthy(): Promise<boolean> {
		const now = this.now();
		if (this.health && now - this.health.at < this.config.senderHealthTtlMs) return this.health.healthy;
		if (!this.healthCheck) {
			this.healthCheck = this.checkHealth()
				.catch(() => false)
				.then((healthy) => {
					this.health = { healthy, at: this.now() };
					this.healthCheck = null;
					return healthy;
				});
		}
		return this.healthCheck;
	}

	private async checkHealth(): Promise<boolean> {
		const timeout = this.config.senderTimeoutMs;
		const list = await this.http.get<{ sessions?: SessionListItem[] }>(`${this.config.senderUrl}/api/sessions`, { timeout });
		const session = pickClientSession((list.data?.sessions || []).filter((item) => item.available !== false));
		if (!session) return false;
		const info = await this.http.get<{ state?: string }>(
			`${this.config.senderUrl}/api/sessions/${encodeURIComponent(session.sessionId)}/session/info`,
			{ timeout }
		);
		return info.data?.state === "CONNECTED";
	}
}
