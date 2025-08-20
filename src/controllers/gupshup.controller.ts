import { Request, Response, Router } from "express";
import gupshupService from "../services/gupshup.service";

const ENDPOINT = "/api/whatsapp/meta/:instance";

class GupshupController {
	constructor(public readonly router: Router) {
		router.post(ENDPOINT + "/webhooks", this.webhookEntry);
		router.get(ENDPOINT + "/webhooks", this.webhookChallenge);
	}

	private webhookEntry = async (req: Request, res: Response) => {
		try {
			const instance = req.params["instance"] as string;
			await gupshupService.handleWebhookEntry(instance, req.body);

			res.status(200).send();
		} catch (err: any) {
			res.status(500).send({ message: err?.message });
		}
	};

	private webhookChallenge = async (req: Request, res: Response) => {
		try {
			console.log("challenge body", req.body);
			console.log("challenge headers", req.headers);

			res.status(200).send();
		} catch (err: any) {
			res.status(500).send({ message: err?.message });
		}
	};
}

export default new GupshupController(Router());
