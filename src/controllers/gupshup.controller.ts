import "dotenv/config";
import { Request, Response, Router } from "express";
import { Logger } from "@in.pulse-crm/utils";
import gupshupService from "../services/gupshup.service";
import ProcessingLogger from "../utils/processing-logger";

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
		const instance = req.params["instance"] as string;
		const processingLogger = new ProcessingLogger(
			instance,
			"webhookEntry",
			`${instance}-${Date.now()}`,
			req.body
		);

		try {
			processingLogger.debug("Gupshup Webhook Entry Received", { body: req.body });
			Logger.debug("Gupshup Webhook Entry Received", { body: req.body });
			const redirectExatron = process.env["REDIRECT_EXATRON_GUPSHUP_WEBHOOK"] === "true";

			processingLogger.debug("Processing Gupshup webhook for instance", { instance, redirectExatron });
			Logger.debug("Processing Gupshup webhook for instance", { instance, redirectExatron });
			if (instance === "exatron" && redirectExatron) {
				processingLogger.debug("Redirecting Gupshup webhook to Exatron");
				Logger.debug("Redirecting Gupshup webhook to Exatron");
				await this.redirectExatronWebhook(req);
				processingLogger.debug("Exatron webhook redirect completed");
				Logger.debug("Exatron webhook redirect completed");
				await gupshupService.handleWebhookEntry(instance, req.body);
				processingLogger.debug("Gupshup webhook entry processing completed", { instance });
				Logger.debug("Gupshup webhook entry processing completed", { instance });
				processingLogger.success({ status: "success", message: "Webhook redirected and processed" });
				res.status(200).send();
				return; // Evita enviar resposta duas vezes
			}
			processingLogger.debug("Handling Gupshup webhook entry");
			Logger.debug("Handling Gupshup webhook entry");
			await gupshupService.handleWebhookEntry(instance, req.body);
			processingLogger.debug("Gupshup webhook entry processing completed", { instance });
			Logger.debug("Gupshup webhook entry processing completed", { instance });
			processingLogger.success({ status: "success", message: "Webhook processed" });
			res.status(200).send();
		} catch (err: any) {
			processingLogger.failed(err);
			Logger.error("Error processing Gupshup webhook entry", err);
			if (!res.headersSent) {
				res.status(500).send({ message: err?.message });
			}
		}
	};

	private redirectExatronWebhook = async (req: Request) => {
		const exatronWebhookUrl = process.env["EXATRON_GUPSHUP_WEBHOOK_URL"];
		if (!exatronWebhookUrl) {
			throw new Error("Exatron webhook URL is not configured");
		}
		await fetch(exatronWebhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(req.body)
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
