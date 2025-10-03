import { Request, Response, Router } from "express";
import wabaService from "../services/waba.service";
import { Logger } from "@in.pulse-crm/utils";

const ENDPOINT = "/api/whatsapp/waba/:instance";

class WABAController {
	constructor(public readonly router: Router) {
		router.post(ENDPOINT + "/webhooks", this.webhookEntry);
		router.get(ENDPOINT + "/webhooks", this.webhookChallenge);
	}

	private webhookEntry = async (req: Request, res: Response) => {
		try {
			const instance = req.params["instance"] as string;
			await wabaService.handleWebhookEntry(instance, req.body);
			res.status(200).send();
		} catch (err: any) {
			res.status(500).send({ message: err?.message });
		}
	};

	private webhookChallenge = async (req: Request, res: Response) => {
		try {
			const mode = req.query["hub.mode"];
			const token = req.query["hub.verify_token"];
			const challenge = req.query["hub.challenge"];
			const instance = req.params["instance"] as string;

			if (mode === "subscribe" && token === process.env["WABA_WEBHOOK_TOKEN"]) {
				Logger.info("WABA Webhook verified successfully for instance " + instance);
				res.status(200).send(challenge);
				return;
			}

			res.status(200).send();
		} catch (err: any) {
			res.status(500).send({ message: err?.message });
		}
	};
}

export default new WABAController(Router());
