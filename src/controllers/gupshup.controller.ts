import { Request, Response, Router } from "express";
import gupshupService from "../services/gupshup.service";
import "dotenv/config";
import { Logger } from "@in.pulse-crm/utils";
import axios from "axios";

const ENDPOINT = "/api/whatsapp/meta/:instance";
const ENDPOINT_NEW = "/api/whatsapp/gupshup/:instance";

class GupshupController {
	constructor(public readonly router: Router) {
		router.post(ENDPOINT + "/webhooks", this.webhookEntry);
		router.get(ENDPOINT + "/webhooks", this.webhookChallenge);
		router.post(ENDPOINT_NEW + "/webhooks", this.webhookEntry);
		router.get(ENDPOINT_NEW + "/webhooks", this.webhookChallenge);
	}

	private webhookEntry = async (req: Request, res: Response) => {
		try {
			const instance = req.params["instance"] as string;
			const redirectExatron = process.env["REDIRECT_EXATRON_GUPSHUP_WEBHOOK"] === "true";

			if (instance === "exatron" && redirectExatron) {
				await this.redirectExatronWebhook(req);
				await gupshupService.handleWebhookEntry(instance, req.body);
				return; // Evita enviar resposta duas vezes
			}

			await gupshupService.handleWebhookEntry(instance, req.body);
			res.status(200).send();
		} catch (err: any) {
			if (!res.headersSent) {
				res.status(500).send({ message: err?.message });
			}
		}
	};

	private redirectExatronWebhook = async (req: Request) => {
		const exatronWebhookUrl = process.env["EXATRON_GUPSHUP_WEBHOOK_URL"];
		Logger.debug("Redirecting Exatron Gupshup webhook to configured URL", exatronWebhookUrl);
		if (!exatronWebhookUrl) {
			Logger.debug("Exatron webhook URL is not configured");
			throw new Error("Exatron webhook URL is not configured");
		}
		const response = await axios.post(exatronWebhookUrl, req.body, {
			headers: { "Content-Type": "application/json" }
		});
		Logger.debug("Exatron webhook response", {
			status: response.status,
			statusText: response.statusText,
			data: response.data
		});
	};

	private webhookChallenge = async (_: Request, res: Response) => {
		try {
			res.status(200).send();
		} catch (err: any) {
			if (!res.headersSent) {
				res.status(500).send({ message: err?.message });
			}
		}
	};
}

export default new GupshupController(Router());
