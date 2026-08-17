import { Request, Response, Router } from "express";
import { Logger } from "@in.pulse-crm/utils";
import remoteClientService from "../services/remote-client.service";
import { RemoteClientEvent } from "../types/remote-client.types";
import { RemoteInboundInboxRequestError } from "../services/remote-inbound-event-inbox.service";

const ENDPOINT = "/api/whatsapp/remote/:clientId";

class RemoteClientController {
	constructor(public readonly router: Router) {
		router.post(ENDPOINT + "/event", this.eventReceived);
	}

	private eventReceived = async (req: Request, res: Response) => {
		try {
			const clientId = req.params["clientId"] as string;
			const event = req.body as RemoteClientEvent;
			const idempotencyKey = req.get("Idempotency-Key")?.trim();
			Logger.info(`[RemoteClientController] Event received | clientId=${clientId} | type=${(event as any)?.type || "unknown"}`);
			const result = await remoteClientService.handleEventReceived(+clientId, event, idempotencyKey);
			Logger.info(`[RemoteClientController] Event processed successfully | clientId=${clientId} | type=${(event as any)?.type || "unknown"}`);
			if (result) {
				const statusCode = result.status === "COMPLETED" ? 200 : 202;
				res.status(statusCode).json({
					accepted: true,
					created: result.created,
					inboxId: result.id,
					idempotencyKey: result.idempotencyKey,
					status: result.status
				});
				return;
			}
			res.status(200).send();
		} catch (err: any) {
			Logger.error("[RemoteClientController] Failed to process event", err as Error);
			if (err instanceof RemoteInboundInboxRequestError) {
				res.status(err.statusCode).json({ message: err.message });
				return;
			}
			res.status(500).send({ message: err?.message });
		}
	};
}

export default new RemoteClientController(Router());
