import { Request, Response, Router } from "express";
import gupshupService from "../services/gupshup.service";
import "dotenv/config";

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
				await this.redirectExatronWebhook(req, res);
				await gupshupService.handleWebhookEntry(instance, req.body);
			} else {
				await gupshupService.handleWebhookEntry(instance, req.body);
				res.status(200).send();
			}
		} catch (err: any) {
			res.status(500).send({ message: err?.message });
		}
	};

	private redirectExatronWebhook = async (req: Request, res: Response) => {
		try {
			const exatronWebhookUrl = process.env["EXATRON_GUPSHUP_WEBHOOK_URL"];
			if (!exatronWebhookUrl) {
				throw new Error("Exatron webhook URL is not configured");
			}
			const response = await fetch(exatronWebhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(req.body)
			});
			if (!response.ok) {
				throw new Error(`Failed to redirect to Exatron webhook: ${response.statusText}`);
			}
			res.status(200).send();
		} catch (err: any) {
			res.status(500).send({ message: err?.message });
		}
	};

	private webhookChallenge = async (_: Request, res: Response) => {
		try {
			res.status(200).send();
		} catch (err: any) {
			res.status(500).send({ message: err?.message });
		}
	};
}

export default new GupshupController(Router());
