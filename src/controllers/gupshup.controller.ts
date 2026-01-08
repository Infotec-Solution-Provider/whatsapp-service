import "dotenv/config";
import { Request, Response, Router } from "express";
import { Logger } from "@in.pulse-crm/utils";
import gupshupWebhookQueueService from "../services/gupshup-webhook-queue.service";
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
			Logger.debug("Gupshup Webhook Entry Received", { body: req.body, instance });

			// Enqueue webhook for processing instead of processing immediately
			const queueId = await gupshupWebhookQueueService.enqueue(instance, req.body);
			
			processingLogger.debug("Webhook enqueued for processing", { queueId, instance });
			Logger.debug("Webhook enqueued for processing", { queueId, instance });
			
			processingLogger.success({ status: "enqueued", queueId, instance });
			res.status(200).send();
		} catch (err: any) {
			processingLogger.failed(err);
			Logger.error("Error enqueuing Gupshup webhook", err);
			if (!res.headersSent) {
				res.status(500).send({ message: err?.message });
			}
		}
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
