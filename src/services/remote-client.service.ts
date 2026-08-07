import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import { Logger } from "@in.pulse-crm/utils";
import { RemoteClientEvent } from "../types/remote-client.types";
import whatsappService from "./whatsapp.service";
import RemoteWhatsappClient from "../whatsapp-client/remote-whatsapp-client";
import remoteSessionMonitorService from "./remote-session-monitor.service";

class RemoteClientService {
	public async handleEventReceived(clientId: number, event: RemoteClientEvent): Promise<void> {
		Logger.info(`[RemoteClientService] Handling remote event | clientId=${clientId} | type=${event.type}`);

		const client = whatsappService.getClient(clientId);

		if (!client) {
			throw new NotFoundError(`Client with id ${clientId} not found`);
		}
		if (!(client instanceof RemoteWhatsappClient)) {
			throw new BadRequestError(`Client with id ${clientId} is not a RemoteWhatsappClient`);
		}
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
			case "message-received":
				await client.handleMessageReceived(event.message);
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
}

export default new RemoteClientService();
