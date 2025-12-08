import { Request, Response, Router } from "express";
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
			await remoteClientService.handleEventReceived(+clientId, req.body as RemoteClientEvent);
			res.status(200).send();
		} catch (err: any) {
			res.status(500).send({ message: err?.message });
		}
	};
}

export default new RemoteClientController(Router());
