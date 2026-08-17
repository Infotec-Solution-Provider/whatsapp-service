import { randomUUID } from "node:crypto";
import { Logger } from "@in.pulse-crm/utils";
import "dotenv/config";
import WhatsappClient from "../whatsapp-client/whatsapp-client";
import WABAWhatsappClient from "../whatsapp-client/waba-whatsapp-client";
import {
	createWwebjsApiClient,
	SessionInfo,
	WwebjsApiClient,
	WwebjsSessionDirectoryItem
} from "../utils/wwebjs-api-client";
import functionalHealthProbeRegistry, {
	FUNCTIONAL_HEALTH_REQUEST_PREFIX,
	FUNCTIONAL_HEALTH_RESPONSE_PREFIX
} from "./functional-health-probe-registry.service";
import whatsappService from "./whatsapp.service";

const OFFICIAL_CLIENT_ID = Number(
	process.env["WWEBJS_HEALTH_OFFICIAL_CLIENT_ID"] || process.env["WWEBJS_HEALTH_CHECK_CLIENT_ID"] || "0"
);
const PROBE_TIMEOUT_MS = Number(process.env["WWEBJS_HEALTH_PROBE_TIMEOUT_MS"] || "60000");
const PROBE_POLL_INTERVAL_MS = Number(process.env["WWEBJS_HEALTH_PROBE_POLL_MS"] || "5000");
const PROBE_RESULT_TTL_MS = Number(process.env["WWEBJS_HEALTH_RESULT_TTL_MS"] || "2700000");

export type FunctionalProbeStatus = "PASSED" | "FAILED" | "SKIPPED";

export interface WhatsappFunctionalHealth {
	clientId: number;
	sessionId: string;
	groupId: string | null;
	role: "PRIMARY" | "SHADOW";
	library: "BAILEYS" | "ZAPO";
	correlationId: string;
	startedAt: string;
	completedAt: string;
	expiresAt: string;
	dispatchStatus: FunctionalProbeStatus;
	officialReceiveStatus: FunctionalProbeStatus;
	responseDispatchStatus: FunctionalProbeStatus;
	receiveStatus: FunctionalProbeStatus;
	officialReceivedAt: string | null;
	responseDispatchedAt: string | null;
	receivedAt: string | null;
	latencyMs: number | null;
	reason: string;
}

export interface HealthCheckTarget {
	clientId?: number;
	remoteClientUrl?: string;
}

export interface HealthCheckDependencies {
	createApiClient(baseUrl?: string): WwebjsApiClient;
	getClient(clientId: number): WhatsappClient | null;
	isOfficialClient(client: WhatsappClient): boolean;
	now(): Date;
	randomId(): string;
	sleep(ms: number): Promise<void>;
	probeTimeoutMs: number;
	probePollIntervalMs: number;
	resultTtlMs: number;
	officialClientId: number;
}

const defaultDependencies: HealthCheckDependencies = {
	createApiClient: (baseUrl) => createWwebjsApiClient(baseUrl),
	getClient: (clientId) => whatsappService.getClient(clientId) || null,
	isOfficialClient: (client) => client instanceof WABAWhatsappClient,
	now: () => new Date(),
	randomId: () => randomUUID(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	probeTimeoutMs: PROBE_TIMEOUT_MS,
	probePollIntervalMs: PROBE_POLL_INTERVAL_MS,
	resultTtlMs: PROBE_RESULT_TTL_MS,
	officialClientId: OFFICIAL_CLIENT_ID
};

export class WwebjsHealthCheckService {
	private readonly latestByClientId = new Map<number, WhatsappFunctionalHealth>();
	private readonly running = new Map<string, Promise<WhatsappFunctionalHealth[]>>();

	constructor(private readonly dependencies: HealthCheckDependencies = defaultDependencies) {}

	public getLatest(clientId: number): WhatsappFunctionalHealth | null {
		return this.latestByClientId.get(clientId) || null;
	}

	public runHealthCheck(target: HealthCheckTarget = {}): Promise<WhatsappFunctionalHealth[]> {
		const key = `${target.remoteClientUrl || "default"}:${target.clientId ?? "all"}`;
		const current = this.running.get(key);
		if (current) return current;
		const operation = this.execute(target).finally(() => this.running.delete(key));
		this.running.set(key, operation);
		return operation;
	}

	private async execute(target: HealthCheckTarget): Promise<WhatsappFunctionalHealth[]> {
		const api = this.dependencies.createApiClient(target.remoteClientUrl);
		let sessions: WwebjsSessionDirectoryItem[];
		try {
			sessions = await api.listSessions();
		} catch (error) {
			Logger.error(`[WwebjsHealthCheck] Failed to load remote session directory: ${this.errorMessage(error)}`);
			return [];
		}

		const selected = this.selectProbeGroups(sessions, target.clientId);
		if (selected.length === 0) {
			Logger.warning("[WwebjsHealthCheck] No eligible remote WhatsApp session was found for functional probing");
			return [];
		}

		const results: WhatsappFunctionalHealth[] = [];
		for (const members of selected) results.push(...(await this.probeGroup(api, members)));
		for (const result of results) this.latestByClientId.set(result.clientId, result);
		return results;
	}

	private selectProbeGroups(
		sessions: WwebjsSessionDirectoryItem[],
		targetClientId?: number
	): WwebjsSessionDirectoryItem[][] {
		const enabled = sessions.filter((session) => session.enabled);
		const target =
			targetClientId === undefined ? null : enabled.find((session) => session.clientId === targetClientId);
		if (targetClientId !== undefined && !target) return [];
		if (target?.monitorGroupId)
			return [enabled.filter((session) => session.monitorGroupId === target.monitorGroupId)];
		if (target) return [[target]];

		const groups = new Map<string, WwebjsSessionDirectoryItem[]>();
		for (const session of enabled) {
			const key = session.monitorGroupId || `session:${session.sessionId}`;
			const members = groups.get(key) || [];
			members.push(session);
			groups.set(key, members);
		}
		return [...groups.values()];
	}

	private async probeGroup(
		api: WwebjsApiClient,
		members: WwebjsSessionDirectoryItem[]
	): Promise<WhatsappFunctionalHealth[]> {
		const startedAt = this.dependencies.now();
		const correlationId = this.dependencies.randomId();
		const primary = members.find((member) => member.monitorRole === "PRIMARY") || members[0];
		if (!primary) return [];

		const sessionInfo = new Map<string, SessionInfo | null>();
		await Promise.all(
			members.map(async (member) => {
				try {
					sessionInfo.set(member.sessionId, await api.getSessionInfo(member.sessionId));
				} catch {
					sessionInfo.set(member.sessionId, null);
				}
			})
		);

		const primaryInfo = sessionInfo.get(primary.sessionId);
		if (!primaryInfo) {
			return this.finishAll(
				members,
				correlationId,
				startedAt,
				"SKIPPED",
				"SKIPPED",
				"The primary session diagnostics endpoint is unavailable"
			);
		}
		if (primaryInfo.status !== "open" || !primaryInfo.phone) {
			return this.finishAll(
				members,
				correlationId,
				startedAt,
				"FAILED",
				"FAILED",
				"The primary session is not open or has no routable phone"
			);
		}

		const primaryClient = this.dependencies.getClient(primary.clientId);
		if (!primaryClient) {
			return this.finishAll(
				members,
				correlationId,
				startedAt,
				"SKIPPED",
				"SKIPPED",
				`Primary health-check client ${primary.clientId} is not available in whatsapp-service`
			);
		}

		const officialClient = this.dependencies.getClient(this.dependencies.officialClientId);
		if (!officialClient || !this.dependencies.isOfficialClient(officialClient) || !officialClient._phone) {
			return this.finishAll(
				members,
				correlationId,
				startedAt,
				"SKIPPED",
				"SKIPPED",
				`Official WABA health-check client ${this.dependencies.officialClientId} is not available`
			);
		}
		if (this.normalizePhone(officialClient._phone) === this.normalizePhone(primaryInfo.phone)) {
			return this.finishAll(
				members,
				correlationId,
				startedAt,
				"SKIPPED",
				"SKIPPED",
				"The official WABA responder must use a different WhatsApp account from the monitored group"
			);
		}

		const deadline = new Date(startedAt.getTime() + this.dependencies.probeTimeoutMs);
		functionalHealthProbeRegistry.register({
			correlationId,
			officialClientId: officialClient.id,
			officialInstance: officialClient.instance,
			requesterPhone: primaryInfo.phone,
			expiresAt: deadline,
			respond: async (to, id) => {
				await officialClient.sendMessage({ to, text: `${FUNCTIONAL_HEALTH_RESPONSE_PREFIX}${id}` });
			}
		});

		try {
			await primaryClient.sendMessage({
				to: officialClient._phone,
				text: `${FUNCTIONAL_HEALTH_REQUEST_PREFIX}${correlationId}`
			});
		} catch (error) {
			functionalHealthProbeRegistry.unregister(correlationId);
			return this.finishAll(
				members,
				correlationId,
				startedAt,
				"FAILED",
				"SKIPPED",
				`Primary-to-official probe dispatch failed: ${this.errorMessage(error)}`
			);
		}

		const received = new Map<string, string>();
		const polled = new Set<string>();
		const pending = new Set(
			members
				.filter((member) => sessionInfo.get(member.sessionId)?.status === "open")
				.map((member) => member.sessionId)
		);
		while (pending.size > 0 && this.dependencies.now().getTime() < deadline.getTime()) {
			await Promise.all(
				[...pending].map(async (sessionId) => {
					try {
						const status = await api.getProbeStatus(correlationId, sessionId);
						polled.add(sessionId);
						if (status.received) {
							received.set(sessionId, status.receivedAt || this.dependencies.now().toISOString());
							pending.delete(sessionId);
						}
					} catch {
						// A transient diagnostics request must not end the probe before its deadline.
					}
				})
			);
			if (pending.size > 0) await this.dependencies.sleep(this.dependencies.probePollIntervalMs);
		}

		const official = functionalHealthProbeRegistry.getSnapshot(correlationId);
		functionalHealthProbeRegistry.unregister(correlationId);
		const officialReceiveStatus: FunctionalProbeStatus = official?.receivedAt ? "PASSED" : "FAILED";
		const responseDispatchStatus: FunctionalProbeStatus = official?.responseDispatchedAt
			? "PASSED"
			: official?.receivedAt
				? "FAILED"
				: "SKIPPED";
		const completedAt = this.dependencies.now();

		return members.map((member) => {
			const receivedAt = received.get(member.sessionId) || null;
			const memberInfo = sessionInfo.get(member.sessionId);
			const receiveStatus: FunctionalProbeStatus = receivedAt
				? "PASSED"
				: memberInfo === null || (memberInfo?.status === "open" && !polled.has(member.sessionId))
					? "SKIPPED"
					: "FAILED";
			const reason = this.resultReason(
				officialReceiveStatus,
				responseDispatchStatus,
				receiveStatus,
				memberInfo,
				official?.responseError || null
			);
			return this.result(
				member,
				correlationId,
				startedAt,
				completedAt,
				"PASSED",
				officialReceiveStatus,
				responseDispatchStatus,
				receiveStatus,
				official?.receivedAt || null,
				official?.responseDispatchedAt || null,
				receivedAt,
				reason
			);
		});
	}

	private resultReason(
		officialReceiveStatus: FunctionalProbeStatus,
		responseDispatchStatus: FunctionalProbeStatus,
		receiveStatus: FunctionalProbeStatus,
		memberInfo: SessionInfo | null | undefined,
		responseError: string | null
	): string {
		if (officialReceiveStatus === "FAILED")
			return "The primary dispatched the probe but the official WABA webhook did not receive it before timeout";
		if (responseDispatchStatus === "FAILED")
			return `The official WABA client received the probe but could not reply${responseError ? `: ${responseError}` : ""}`;
		if (receiveStatus === "PASSED")
			return "Primary outbound, official WABA inbound/outbound, and this session inbound all passed";
		if (receiveStatus === "SKIPPED")
			return "The official WABA round trip passed but this session diagnostics endpoint was unavailable";
		return memberInfo?.status === "open"
			? "The official WABA round trip passed but this session did not observe the response before timeout"
			: "The official WABA round trip passed but this session was not open";
	}

	private finishAll(
		members: WwebjsSessionDirectoryItem[],
		correlationId: string,
		startedAt: Date,
		dispatchStatus: FunctionalProbeStatus,
		receiveStatus: FunctionalProbeStatus,
		reason: string
	): WhatsappFunctionalHealth[] {
		const completedAt = this.dependencies.now();
		return members.map((member) =>
			this.result(
				member,
				correlationId,
				startedAt,
				completedAt,
				dispatchStatus,
				"SKIPPED",
				"SKIPPED",
				receiveStatus,
				null,
				null,
				null,
				reason
			)
		);
	}

	private result(
		member: WwebjsSessionDirectoryItem,
		correlationId: string,
		startedAt: Date,
		completedAt: Date,
		dispatchStatus: FunctionalProbeStatus,
		officialReceiveStatus: FunctionalProbeStatus,
		responseDispatchStatus: FunctionalProbeStatus,
		receiveStatus: FunctionalProbeStatus,
		officialReceivedAt: string | null,
		responseDispatchedAt: string | null,
		receivedAt: string | null,
		reason: string
	): WhatsappFunctionalHealth {
		const receivedTimestamp = receivedAt ? new Date(receivedAt).getTime() : Number.NaN;
		return {
			clientId: member.clientId,
			sessionId: member.sessionId,
			groupId: member.monitorGroupId,
			role: member.monitorRole,
			library: member.library,
			correlationId,
			startedAt: startedAt.toISOString(),
			completedAt: completedAt.toISOString(),
			expiresAt: new Date(completedAt.getTime() + this.dependencies.resultTtlMs).toISOString(),
			dispatchStatus,
			officialReceiveStatus,
			responseDispatchStatus,
			receiveStatus,
			officialReceivedAt,
			responseDispatchedAt,
			receivedAt,
			latencyMs: Number.isFinite(receivedTimestamp) ? Math.max(0, receivedTimestamp - startedAt.getTime()) : null,
			reason
		};
	}

	private normalizePhone(value: string): string {
		return value.replace(/^me:/, "").split("@")[0]?.replace(/\D/g, "") || "";
	}

	private errorMessage(error: unknown): string {
		return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]/g, " ").slice(0, 500);
	}
}

export default new WwebjsHealthCheckService();
