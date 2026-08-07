import { Request, Response, Router } from "express";
import { Logger } from "@in.pulse-crm/utils";
import remoteClientService from "../services/remote-client.service";
import { RemoteClientEvent } from "../types/remote-client.types";

const ENDPOINT = "/api/whatsapp/remote/:clientId";

class RemoteClientController {
	constructor(public readonly router: Router) {
		router.post(ENDPOINT + "/event", this.eventReceived);
	}

	private eventReceived = async (req: Request, res: Response) => {
		try {
			const clientId = req.params["clientId"] as string;
			const event = req.body as RemoteClientEvent;
			Logger.info(`[RemoteClientController] Event received | clientId=${clientId} | type=${(event as any)?.type || "unknown"}`);
			await remoteClientService.handleEventReceived(+clientId, event);
			Logger.info(`[RemoteClientController] Event processed successfully | clientId=${clientId} | type=${(event as any)?.type || "unknown"}`);
			res.status(200).send();
		} catch (err: any) {
			Logger.error("[RemoteClientController] Failed to process event", err as Error);
			res.status(500).send({ message: err?.message });
		}
	};
}

export default new RemoteClientController(Router());
