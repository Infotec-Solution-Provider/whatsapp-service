import { randomUUID } from "node:crypto";
import { SessionData, SocketEventType, SocketServerAdminRoom } from "../sdk-local";
import { WppClientType } from "@prisma/client";
import axios, { AxiosError } from "axios";
import { RemoteAuthBatch, RemoteSessionDirectoryItem, RemoteSessionInfo } from "../types/remote-client.types";
import prismaService from "./prisma.service";
import socketService from "./socket.service";
import { calculateSessionStability } from "./remote-session-stability";
import wwebjsHealthCheckService from "./wwebjs-health-check.service";

const REMOTE_TIMEOUT_MS = 5_000;
const STABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class RemoteSessionMonitorError extends Error {
	constructor(
		public readonly statusCode: number,
		message: string
	) {
		super(message);
		this.name = "RemoteSessionMonitorError";
	}
}

type SnapshotSource = "WEBHOOK" | "POLL";

interface SnapshotContext {
	source: SnapshotSource;
	traceId: string;
	occurredAt: string;
}

function optionalDate(value: string | null): Date | null {
	if (!value) {
		return null;
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new RemoteSessionMonitorError(502, "Remote session returned an invalid timestamp");
	}
	return date;
}

function requiredDate(value: string): Date {
	const date = optionalDate(value);
	if (!date) {
		throw new RemoteSessionMonitorError(502, "Remote session returned an incomplete timestamp");
	}
	return date;
}

function sanitizedReason(reason: string | null): string | null {
	return reason ? reason.replace(/[\r\n\t]/g, " ").slice(0, 255) : null;
}

class RemoteSessionMonitorService {
	public async recordSnapshot(clientId: number, session: RemoteSessionInfo, context: SnapshotContext): Promise<void> {
		const client = await prismaService.wppClient.findFirst({
			where: { id: clientId, type: WppClientType.REMOTE, isActive: true },
			include: { sectors: true, sessionSnapshot: true }
		});

		if (!client) {
			throw new RemoteSessionMonitorError(404, "Remote WhatsApp client not found");
		}

		const observedAt = requiredDate(session.observedAt);
		const stateChangedAt = requiredDate(session.stateChangedAt);
		const reason = sanitizedReason(session.lastDisconnectReason);
		const previousState = client.sessionSnapshot?.state || null;
		const transitionChanged =
			previousState !== session.state || client.sessionSnapshot?.lastDisconnectReason !== reason;

		await prismaService.$transaction(async (transaction) => {
			await transaction.wppClientSessionSnapshot.upsert({
				where: { clientId },
				create: {
					clientId,
					contractVersion: session.contractVersion,
					state: session.state,
					phone: session.phone || null,
					processStartedAt: requiredDate(session.processStartedAt),
					stateChangedAt,
					lastActivityAt: optionalDate(session.lastActivityAt),
					connectedSince: optionalDate(session.connectedSince),
					lastConnectedAt: optionalDate(session.lastConnectedAt),
					lastDisconnectedAt: optionalDate(session.lastDisconnectedAt),
					lastDisconnectReason: reason,
					reconnectAttempts: session.reconnectAttempts,
					lastReconnectAt: optionalDate(session.lastReconnectAt),
					lastObservedAt: observedAt,
					currentOperationId: session.currentOperation?.id || null,
					currentOperationType: session.currentOperation?.type || null,
					currentOperationStarted: optionalDate(session.currentOperation?.startedAt || null),
					consecutivePollFailures: 0
				},
				update: {
					contractVersion: session.contractVersion,
					state: session.state,
					phone: session.phone || null,
					processStartedAt: requiredDate(session.processStartedAt),
					stateChangedAt,
					lastActivityAt: optionalDate(session.lastActivityAt),
					connectedSince: optionalDate(session.connectedSince),
					lastConnectedAt: optionalDate(session.lastConnectedAt),
					lastDisconnectedAt: optionalDate(session.lastDisconnectedAt),
					lastDisconnectReason: reason,
					reconnectAttempts: session.reconnectAttempts,
					lastReconnectAt: optionalDate(session.lastReconnectAt),
					lastObservedAt: observedAt,
					currentOperationId: session.currentOperation?.id || null,
					currentOperationType: session.currentOperation?.type || null,
					currentOperationStarted: optionalDate(session.currentOperation?.startedAt || null),
					consecutivePollFailures: 0
				}
			});

			if (transitionChanged) {
				await transaction.wppClientSessionEvent.createMany({
					data: [
						{
							clientId,
							previousState,
							state: session.state,
							reason,
							occurredAt: requiredDate(context.occurredAt),
							traceId: context.traceId,
							transitionKey: `${clientId}:${session.state}:${stateChangedAt.toISOString()}`,
							source: context.source
						}
					],
					skipDuplicates: true
				});
			}

			if (session.state === "QR_PENDING" || session.state === "LOGGED_OUT") {
				await transaction.wppClient.update({ where: { id: clientId }, data: { phone: null } });
			} else if (session.state === "CONNECTED" && session.phone) {
				await transaction.wppClient.update({ where: { id: clientId }, data: { phone: session.phone } });
			}
		});

		this.emitStatus(client, session, observedAt);
	}

	public async recordLogout(clientId: number): Promise<void> {
		await prismaService.wppClient.updateMany({
			where: { id: clientId, type: WppClientType.REMOTE },
			data: { phone: null }
		});
	}

	public async listClients(session: SessionData) {
		const clients = await prismaService.wppClient.findMany({
			where: this.visibleClientWhere(session),
			select: {
				id: true,
				name: true,
				phone: true,
				remoteClientUrl: true,
				sessionSnapshot: true
			},
			orderBy: { name: "asc" }
		});

		const [disconnections, directory] = await Promise.all([
			this.countUnexpectedDisconnections(clients.map((client) => client.id)),
			this.loadRemoteSessionDirectory(clients)
		]);
		return clients.map((client) => ({
			...this.toClientResponse(client, disconnections.get(client.id) || 0),
			...this.sessionMetadata(directory.get(client.id))
		}));
	}

	public async getClientDetail(session: SessionData, clientId: number) {
		const client = await prismaService.wppClient.findFirst({
			where: { ...this.visibleClientWhere(session), id: clientId },
			select: { id: true, name: true, phone: true, sessionSnapshot: true }
		});

		if (!client) {
			throw new RemoteSessionMonitorError(404, "Remote WhatsApp client not found");
		}

		const since = new Date(Date.now() - STABILITY_WINDOW_MS);
		const events = await prismaService.wppClientSessionEvent.findMany({
			where: { clientId, occurredAt: { gte: since } },
			select: { id: true, previousState: true, state: true, reason: true, occurredAt: true, source: true },
			orderBy: { occurredAt: "desc" },
			take: 200
		});
		const disconnectCount = events.filter(
			(event) => event.state === "DISCONNECTED" || event.state === "ERROR"
		).length;

		return { ...this.toClientResponse(client, disconnectCount), events };
	}

	public async restart(session: SessionData, clientId: number) {
		const { client, pathPrefix } = await this.getScopedRemoteSessionTarget(session, clientId);
		return this.remoteRequest(client.remoteClientUrl, "post", `${pathPrefix}/session/restart`);
	}

	public async resetForQr(session: SessionData, clientId: number, confirmed: boolean) {
		if (!confirmed) {
			throw new RemoteSessionMonitorError(400, "Confirmation is required to generate a new QR code");
		}

		const { client, pathPrefix } = await this.getScopedRemoteSessionTarget(session, clientId);
		return this.remoteRequest(client.remoteClientUrl, "post", `${pathPrefix}/session/reset-qr`, { confirm: true });
	}

	public async getQr(session: SessionData, clientId: number) {
		const { client, pathPrefix } = await this.getScopedRemoteSessionTarget(session, clientId);
		return this.remoteRequest(client.remoteClientUrl, "get", `${pathPrefix}/session/qr`);
	}

	public async runFunctionalCheck(session: SessionData, clientId: number) {
		const client = await this.getScopedRemoteClient(session, clientId);
		return wwebjsHealthCheckService.runHealthCheck({
			clientId,
			remoteClientUrl: client.remoteClientUrl!
		});
	}

	public async createAuthBatch(
		session: SessionData,
		clientId: number,
		monitorGroupId: string
	): Promise<RemoteAuthBatch> {
		if (!monitorGroupId.trim()) throw new RemoteSessionMonitorError(400, "Monitoring group id is required");
		const client = await this.getScopedRemoteClient(session, clientId);
		await this.assertClientMonitorGroup(client, monitorGroupId.trim());
		return this.remoteRequest(client.remoteClientUrl, "post", "/api/auth-batches", {
			monitorGroupId: monitorGroupId.trim(),
			createdBy: `whatsapp-service:${clientId}`
		});
	}

	public async getAuthBatch(session: SessionData, clientId: number, batchId: string): Promise<RemoteAuthBatch> {
		return (await this.getAuthorizedAuthBatch(session, clientId, batchId)).batch;
	}

	public async activateNextAuthItem(
		session: SessionData,
		clientId: number,
		batchId: string
	): Promise<RemoteAuthBatch> {
		const { client } = await this.getAuthorizedAuthBatch(session, clientId, batchId);
		return this.remoteRequest(
			client.remoteClientUrl,
			"post",
			`/api/auth-batches/${encodeURIComponent(batchId)}/next`
		);
	}

	public async retryAuthItem(
		session: SessionData,
		clientId: number,
		batchId: string,
		itemId: number
	): Promise<RemoteAuthBatch> {
		const { client } = await this.getAuthorizedAuthBatch(session, clientId, batchId);
		return this.remoteRequest(
			client.remoteClientUrl,
			"post",
			`/api/auth-batches/${encodeURIComponent(batchId)}/items/${itemId}/retry`
		);
	}

	public async cancelAuthBatch(session: SessionData, clientId: number, batchId: string): Promise<RemoteAuthBatch> {
		const { client } = await this.getAuthorizedAuthBatch(session, clientId, batchId);
		return this.remoteRequest(
			client.remoteClientUrl,
			"post",
			`/api/auth-batches/${encodeURIComponent(batchId)}/cancel`
		);
	}

	public async getAuthBatchQr(session: SessionData, clientId: number, batchId: string): Promise<unknown> {
		const { client, batch } = await this.getAuthorizedAuthBatch(session, clientId, batchId);
		const activeItem = batch.items.find((item) => item.status === "ACTIVATING" || item.status === "QR_PENDING");
		const activeClient = activeItem ? await this.getScopedRemoteClient(session, activeItem.clientId) : client;
		return this.remoteRequest(
			activeClient.remoteClientUrl,
			"get",
			`/api/auth-batches/${encodeURIComponent(batchId)}/qr`
		);
	}

	public async refreshClient(clientId: number): Promise<void> {
		const client = await prismaService.wppClient.findFirst({
			where: { id: clientId, type: WppClientType.REMOTE, isActive: true },
			select: { remoteClientUrl: true }
		});

		if (!client?.remoteClientUrl) {
			throw new RemoteSessionMonitorError(404, "Remote WhatsApp client not found");
		}

		try {
			const directory = await this.remoteRequest<{ sessions: RemoteSessionDirectoryItem[] }>(
				client.remoteClientUrl,
				"get",
				"/api/sessions"
			).catch(() => null);
			const remoteSessionId = directory?.sessions?.find((item) => item.clientId === clientId)?.sessionId;
			const pathPrefix = remoteSessionId ? `/api/sessions/${encodeURIComponent(remoteSessionId)}` : "/api";
			const session = await this.remoteRequest<RemoteSessionInfo>(
				client.remoteClientUrl,
				"get",
				`${pathPrefix}/session/info`
			);
			await this.recordSnapshot(clientId, session, {
				source: "POLL",
				traceId: randomUUID(),
				occurredAt: session.observedAt
			});
		} catch (error) {
			await prismaService.wppClientSessionSnapshot.updateMany({
				where: { clientId },
				data: { consecutivePollFailures: { increment: 1 } }
			});
			throw error;
		}
	}

	public async pollAll(): Promise<void> {
		const clients = await prismaService.wppClient.findMany({
			where: { type: WppClientType.REMOTE, isActive: true, remoteClientUrl: { not: null } },
			select: { id: true }
		});

		for (let index = 0; index < clients.length; index += 5) {
			const batch = clients.slice(index, index + 5);
			await Promise.allSettled(batch.map((client) => this.refreshClient(client.id)));
		}
	}

	public async cleanupEvents(): Promise<void> {
		await prismaService.wppClientSessionEvent.deleteMany({
			where: { occurredAt: { lt: new Date(Date.now() - EVENT_RETENTION_MS) } }
		});
	}

	private visibleClientWhere(session: SessionData) {
		return {
			instance: session.instance,
			type: WppClientType.REMOTE,
			isActive: true,
			...(session.sectorId ? { sectors: { some: { id: session.sectorId } } } : {})
		};
	}

	private async getScopedRemoteClient(session: SessionData, clientId: number) {
		const client = await prismaService.wppClient.findFirst({
			where: { ...this.visibleClientWhere(session), id: clientId },
			select: { id: true, remoteClientUrl: true }
		});

		if (!client?.remoteClientUrl) {
			throw new RemoteSessionMonitorError(404, "Remote WhatsApp client not found");
		}
		return client;
	}

	private async getScopedRemoteSessionTarget(session: SessionData, clientId: number) {
		const client = await this.getScopedRemoteClient(session, clientId);
		const directory = await this.remoteRequest<{ sessions: RemoteSessionDirectoryItem[] }>(
			client.remoteClientUrl,
			"get",
			"/api/sessions"
		).catch(() => null);
		const sessionId = directory?.sessions?.find((item) => item.clientId === clientId)?.sessionId;
		return {
			client,
			pathPrefix: sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}` : "/api"
		};
	}

	private async getAuthorizedAuthBatch(session: SessionData, clientId: number, batchId: string) {
		const client = await this.getScopedRemoteClient(session, clientId);
		const batch = await this.remoteRequest<RemoteAuthBatch>(
			client.remoteClientUrl,
			"get",
			`/api/auth-batches/${encodeURIComponent(batchId)}`
		);
		await this.assertClientMonitorGroup(client, batch.groupId);
		return { client, batch };
	}

	private async assertClientMonitorGroup(
		client: { id: number; remoteClientUrl: string | null },
		groupId: string
	): Promise<void> {
		const directory = await this.remoteRequest<{ sessions: RemoteSessionDirectoryItem[] }>(
			client.remoteClientUrl,
			"get",
			"/api/sessions"
		);
		const member = directory.sessions?.find((item) => item.clientId === client.id);
		if (!member || member.monitorGroupId !== groupId) {
			throw new RemoteSessionMonitorError(
				403,
				"The selected WhatsApp client does not belong to this monitoring group"
			);
		}
	}

	private async countUnexpectedDisconnections(clientIds: number[]): Promise<Map<number, number>> {
		if (clientIds.length === 0) {
			return new Map();
		}

		const events = await prismaService.wppClientSessionEvent.groupBy({
			by: ["clientId"],
			where: {
				clientId: { in: clientIds },
				occurredAt: { gte: new Date(Date.now() - STABILITY_WINDOW_MS) },
				state: { in: ["DISCONNECTED", "ERROR"] }
			},
			_count: { _all: true }
		});

		return new Map(events.map((event) => [event.clientId, event._count._all]));
	}

	private toClientResponse(
		client: { id: number; name: string; phone: string | null; sessionSnapshot: any },
		disconnectCount: number
	) {
		const snapshot = client.sessionSnapshot;
		const functionalHealth = wwebjsHealthCheckService.getLatest(client.id);
		const stability = calculateSessionStability(snapshot, disconnectCount, Date.now(), functionalHealth);

		return {
			id: client.id,
			name: client.name,
			phone: snapshot?.phone || client.phone,
			snapshot,
			functionalHealth,
			stability: stability.level,
			stabilityReason: stability.reason,
			disconnections24h: disconnectCount,
			connectedUptimeSeconds: snapshot?.connectedSince
				? Math.max(0, Math.floor((Date.now() - snapshot.connectedSince.getTime()) / 1000))
				: 0
		};
	}

	private async loadRemoteSessionDirectory(
		clients: Array<{ id: number; remoteClientUrl: string | null }>
	): Promise<Map<number, RemoteSessionDirectoryItem>> {
		const byClientId = new Map<number, RemoteSessionDirectoryItem>();
		const urls = [
			...new Set(clients.map((client) => client.remoteClientUrl).filter((url): url is string => !!url))
		];
		await Promise.all(
			urls.map(async (url) => {
				try {
					const response = await this.remoteRequest<{ sessions: RemoteSessionDirectoryItem[] }>(
						url,
						"get",
						"/api/sessions"
					);
					for (const item of response.sessions || []) byClientId.set(item.clientId, item);
				} catch {
					// Session monitoring remains available when an older remote does not expose the directory.
				}
			})
		);
		return byClientId;
	}

	private sessionMetadata(item: RemoteSessionDirectoryItem | undefined) {
		return {
			sessionId: item?.sessionId || null,
			library: item?.library || null,
			monitorGroupId: item?.monitorGroupId || null,
			monitorRole: item?.monitorRole || null,
			authBatchId: item?.authBatchId || null,
			authQueueStatus: item?.authQueueStatus || null
		};
	}

	private emitStatus(
		client: { id: number; name: string; instance: string; sectors: Array<{ id: number }> },
		session: RemoteSessionInfo,
		observedAt: Date
	): void {
		const payload = {
			clientId: client.id,
			name: client.name,
			phone: session.phone || null,
			state: session.state,
			stateChangedAt: session.stateChangedAt,
			lastObservedAt: observedAt.toISOString(),
			reconnectAttempts: session.reconnectAttempts,
			currentOperation: session.currentOperation
		};

		client.sectors.forEach((sector) => {
			const room: SocketServerAdminRoom = `${client.instance}:${sector.id}:admin`;
			void socketService.emit(SocketEventType.WwebjsSessionStatus, room, payload);
		});
	}

	private async remoteRequest<T = unknown>(
		baseUrl: string | null,
		method: "get" | "post",
		path: string,
		data?: unknown
	): Promise<T> {
		if (!baseUrl) {
			throw new RemoteSessionMonitorError(404, "Remote WhatsApp client not found");
		}

		try {
			const response = await axios.request<T>({
				baseURL: baseUrl,
				url: path,
				method,
				data,
				timeout: REMOTE_TIMEOUT_MS,
				headers: { "Cache-Control": "no-store" }
			});
			return response.data;
		} catch (error) {
			const axiosError = error as AxiosError;
			if (axiosError.code === "ECONNABORTED") {
				throw new RemoteSessionMonitorError(504, "Remote WhatsApp session timed out");
			}
			if (axiosError.response?.status && axiosError.response.status >= 400 && axiosError.response.status < 500) {
				const message =
					(axiosError.response.data as { error?: string; message?: string } | undefined)?.message ||
					(axiosError.response.data as { error?: string } | undefined)?.error ||
					"Remote WhatsApp request was rejected";
				throw new RemoteSessionMonitorError(axiosError.response.status, message);
			}
			if (axiosError.response?.status === 503) {
				const message =
					(axiosError.response.data as { error?: string; message?: string } | undefined)?.message ||
					(axiosError.response.data as { error?: string } | undefined)?.error ||
					"Remote WhatsApp session is still starting";
				throw new RemoteSessionMonitorError(503, message);
			}
			throw new RemoteSessionMonitorError(502, "Remote WhatsApp session is unavailable");
		}
	}
}

export default new RemoteSessionMonitorService();
