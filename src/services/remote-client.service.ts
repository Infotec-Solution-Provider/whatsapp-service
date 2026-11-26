import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import { Logger } from "@in.pulse-crm/utils";
import { RemoteClientEvent } from "../types/remote-client.types";
import whatsappService from "./whatsapp.service";
import RemoteWhatsappClient from "../whatsapp-client/remote-whatsapp-client";
import remoteSessionMonitorService from "./remote-session-monitor.service";
import remoteInboundEventInboxService, {
	RemoteInboundInboxEnqueueResult,
	RemoteInboundInboxProcessResult,
	RemoteInboundPayload
} from "./remote-inbound-event-inbox.service";
import { RemoteInboundEventInbox, WppMessageStatus } from "@prisma/client";
import { admit, centralIngressEnabled, IngressConflict, remoteReceiptCompleted } from "./homolog-ingress";
import {
	getRemoteInboundProviderMessageId, hashRemoteInboundPayload, RemoteInboundInboxRequestError,
	resolveRemoteInboundIdempotencyKey
} from "./remote-inbound-event-inbox.service";
import prismaService from "./prisma.service";
import messageReactionsService from "./message-reactions.service";
import { tenantSqlEnabled } from "../tenant-sql/registry";
import { isTenantSqlTargetPrepared } from "../tenant-sql/router";
import { currentDatabaseTenant, withDatabaseTenant } from "../utils/database-tenant-context";
import { AsyncConcurrencyLimiter, AsyncKeyedSequencer } from "../utils/async-concurrency-limiter";

const INFOTEC_ID_FLOOR = 2_000_000_000;

class RemoteClientService {
	public hasRunningChannel(instance: string, clientId: number): boolean {
		const client = whatsappService.getClient(clientId);
		return client instanceof RemoteWhatsappClient && client.instance === instance;
	}
	private readonly receiptSequencer = new AsyncKeyedSequencer();
	private readonly receiptProcessing = new AsyncConcurrencyLimiter(4);
	private async withClientTenant<T>(clientId: number, execute: () => Promise<T>): Promise<T> {
		if (!tenantSqlEnabled()) return execute();
		// Infotec was provisioned above every historical ID and owns offset 3 of increment 4.
		const infotec = Number.isSafeInteger(clientId) && clientId >= INFOTEC_ID_FLOOR && clientId % 4 === 3 &&
			isTenantSqlTargetPrepared(prismaService, "infotec");
		// Runtime registration rejects cross-tenant channel collisions. Confirm the
		// hinted owner in its own database before accepting an event.
		const loaded = whatsappService.getClient(clientId);
		const loadedTenant = loaded instanceof RemoteWhatsappClient && isTenantSqlTargetPrepared(prismaService, loaded.instance)
			? loaded.instance : undefined;
		const instance = infotec ? "infotec" : currentDatabaseTenant() ?? loadedTenant;
		const registered = await prismaService.wppClient.findFirst({
			where: { id: clientId, type: "REMOTE", ...(instance ? { instance } : {}) },
			select: { instance: true }
		});
		if (!registered) throw new NotFoundError("Remote client not found");
		return withDatabaseTenant(registered.instance, execute);
	}
	private getRemoteClient(clientId: number): RemoteWhatsappClient {
		const client = whatsappService.getClient(clientId);
		const tenant = currentDatabaseTenant();

		if (!client || (tenant && tenant !== client.instance)) {
			throw new NotFoundError(`Client with id ${clientId} not found`);
		}
		if (!(client instanceof RemoteWhatsappClient)) {
			throw new BadRequestError(`Client with id ${clientId} is not a RemoteWhatsappClient`);
		}
		return client;
	}

	public async handleEventReceived(
		clientId: number,
		event: RemoteClientEvent,
		idempotencyKey?: string
	): Promise<RemoteInboundInboxEnqueueResult | void> {
		if (centralIngressEnabled && (event.type === "message-received" || event.type === "message-status-received")) {
			if (!Number.isSafeInteger(clientId) || clientId < 1) throw new RemoteInboundInboxRequestError("Invalid client", 400);
			if (event.type === "message-status-received" && (typeof event.messageId !== "string" || !event.messageId.trim() ||
				event.messageId.length > 255 || !Object.values(WppMessageStatus).includes(event.status as WppMessageStatus))) {
				throw new RemoteInboundInboxRequestError("Invalid remote status", 400);
			}
			const payload: RemoteInboundPayload = event.type === "message-received"
				? { type: event.type, clientId, message: event.message }
				: { type: event.type, clientId, messageId: event.messageId.trim(), status: event.status as WppMessageStatus };
			const providerId = payload.type === "message-received" ? getRemoteInboundProviderMessageId(payload.message) : payload.messageId;
			if (providerId.length > 255) throw new RemoteInboundInboxRequestError("Invalid provider ID", 400);
			const eventType = payload.type === "message-received" ? payload.type : payload.type + ":" + payload.status;
			const hash = hashRemoteInboundPayload(payload);
			const key = payload.type === "message-received" ? resolveRemoteInboundIdempotencyKey(idempotencyKey, clientId, payload.message) : "remote-status:v1:" + hash;
			try {
				const [receipt] = await admit("REMOTE", currentDatabaseTenant() ?? undefined, [{
					route: String(clientId), key: JSON.stringify([eventType,providerId]), transportKey: key,
					content: { payload, key, providerId, eventType }, hash
				}]);
				if (!receipt) throw new Error("Missing ingress receipt");
				const completed = receipt.handedOff && await remoteReceiptCompleted(receipt.tenant, clientId, eventType, providerId);
				return { id: receipt.id, created: receipt.created, idempotencyKey: key, status: completed ? "COMPLETED" : "PENDING" };
			} catch (error) {
				if (error instanceof IngressConflict) throw new RemoteInboundInboxRequestError("Conflicting remote event", 409);
				throw error;
			}
		}
		return this.withClientTenant(clientId, async () => {
		Logger.info(`[RemoteClientService] Handling remote event | clientId=${clientId} | type=${event.type}`);

		// Message delivery is acknowledged after the durable inbox write, even
		// while the runtime client is restarting. The worker resolves the client
		// and retries later.
		if (event.type === "message-received") {
			return remoteInboundEventInboxService.enqueue(clientId, event.message, idempotencyKey);
		}
		if (event.type === "message-status-received") {
			return remoteInboundEventInboxService.enqueueStatus(clientId, event.messageId, event.status);
		}
		if (event.type === "message-reaction") {
			// Callback acceptance depends on storage, not a runtime that may be restarting.
			const registered = await prismaService.wppClient.findFirst({ where: { id: clientId, type: "REMOTE" } });
			if (!registered) throw new NotFoundError("Remote reaction client not found");
			await messageReactionsService.receive(registered, event, process.env["ENABLE_INTERNAL_GROUP_WHATSAPP_SYNC"] !== "false");
			return;
		}

		const client = this.getRemoteClient(clientId);
		switch (event.type) {
			case "qr-received":
				await client.handleQr(event.qr);
				break;
			case "auth-success":
				await client.handleAuthSuccess(event.phoneNumber);
				break;
			case "auth-logout":
				await remoteSessionMonitorService.recordLogout(clientId);
				break;
			case "session-status-changed":
				await remoteSessionMonitorService.recordSnapshot(clientId, event.session, {
					source: "WEBHOOK",
					traceId: event.traceId,
					occurredAt: event.occurredAt
				});
				break;
			case "message-edited":
				await client.handleMessageEdited(event.message);
				break;
			case "message-revoked":
				await client.handleMessageRevoked(event);
				break;
			default:
				throw new BadRequestError(`Unknown event type: ${(event as any).type}`);
		}

		Logger.info(`[RemoteClientService] Remote event handled | clientId=${clientId} | type=${event.type}`);
		return undefined;
		});
	}

	public async processInboundInboxItem(
		item: RemoteInboundEventInbox,
		payload: RemoteInboundPayload
	): Promise<RemoteInboundInboxProcessResult> {
		return this.withClientTenant(item.clientId, async () => {
		if (item.clientId !== payload.clientId) {
			throw new Error(`Inbox client mismatch for ${item.id}`);
		}
		const client = this.getRemoteClient(item.clientId);
		if (payload.type === "message-status-received") {
			await this.receiptSequencer.run(`${item.clientId}:${payload.messageId}`, () =>
				this.receiptProcessing.run(() => client.handleMessageStatus(payload.messageId, payload.status)));
			return { messageId: null };
		}
		const messageId = await client.handleMessageReceived(payload.message);
		return { messageId };
		});
	}
}

export default new RemoteClientService();
