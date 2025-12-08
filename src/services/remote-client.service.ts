import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import { RemoteClientEvent } from "../types/remote-client.types";
import whatsappService from "./whatsapp.service";
import RemoteWhatsappClient from "../whatsapp-client/remote-whatsapp-client";

class RemoteClientService {
	public async handleEventReceived(clientId: number, event: RemoteClientEvent): Promise<void> {
		const client = whatsappService.getClient(clientId);

		if (!client) {
			throw new NotFoundError(`Client with id ${clientId} not found`);
		}
		if (!(client instanceof RemoteWhatsappClient)) {
			throw new BadRequestError(`Client with id ${clientId} is not a RemoteWhatsappClient`);
		}
		switch (event.type) {
			case "qr-received":
				client.handleQr(event.qr);
				break;
			case "auth-success":
				client.handleAuthSuccess(event.phoneNumber);
				break;
			case "message-received":
				client.handleMessageReceived(event.message);
				break;
			case "message-status-received":
				client.handleMessageStatus(event.messageId, event.status);
				break;
			default:
				throw new BadRequestError(`Unknown event type: ${(event as any).type}`);
		}
	}
}

export default new RemoteClientService();
