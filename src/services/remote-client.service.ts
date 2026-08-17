import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import { Logger } from "@in.pulse-crm/utils";
import { RemoteClientEvent } from "../types/remote-client.types";
import whatsappService from "./whatsapp.service";
import RemoteWhatsappClient from "../whatsapp-client/remote-whatsapp-client";
import remoteSessionMonitorService from "./remote-session-monitor.service";
import remoteInboundEventInboxService, {
	RemoteInboundInboxEnqueueResult,
	RemoteInboundInboxProcessResult,
	RemoteInboundMessagePayload
} from "./remote-inbound-event-inbox.service";
import { RemoteInboundEventInbox } from "@prisma/client";

class RemoteClientService {
	private getRemoteClient(clientId: number): RemoteWhatsappClient {
		const client = whatsappService.getClient(clientId);

		if (!client) {
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
		Logger.info(`[RemoteClientService] Handling remote event | clientId=${clientId} | type=${event.type}`);

		// Message delivery is acknowledged after the durable inbox write, even
		// while the runtime client is restarting. The worker resolves the client
		// and retries later.
		if (event.type === "message-received") {
			return remoteInboundEventInboxService.enqueue(clientId, event.message, idempotencyKey);
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
			case "message-reaction":
				await client.handleMessageReaction(event);
				break;
			case "message-revoked":
				await client.handleMessageRevoked(event);
				break;
			case "message-status-received":
				await client.handleMessageStatus(event.messageId, event.status);
				break;
			default:
				throw new BadRequestError(`Unknown event type: ${(event as any).type}`);
		}

		Logger.info(`[RemoteClientService] Remote event handled | clientId=${clientId} | type=${event.type}`);
	}

	public async processInboundInboxItem(
		item: RemoteInboundEventInbox,
		payload: RemoteInboundMessagePayload
	): Promise<RemoteInboundInboxProcessResult> {
		if (item.clientId !== payload.clientId) {
			throw new Error(`Inbox client mismatch for ${item.id}`);
		}
		const client = this.getRemoteClient(item.clientId);
		const messageId = await client.handleMessageReceived(payload.message);
		return { messageId };
	}
}

export default new RemoteClientService();
