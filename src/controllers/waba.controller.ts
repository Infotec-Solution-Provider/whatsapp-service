import { Request, Response, Router } from "express";
import { Logger } from "@in.pulse-crm/utils";
import ProcessingLogger from "../utils/processing-logger";
import wabaWebhookQueueService from "../services/waba-webhook-queue.service";

const ENDPOINT = "/api/whatsapp/waba/:instance";

class WABAController {
	constructor(public readonly router: Router) {
		router.post(ENDPOINT + "/webhooks", this.webhookEntry);
		router.get(ENDPOINT + "/webhooks", this.webhookChallenge);
	}

	private webhookEntry = async (req: Request, res: Response) => {
		const instance = req.params["instance"] as string;
		const processingLogger = new ProcessingLogger(
			instance,
			"waba-webhook-entry",
			`${instance}-${Date.now()}`,
			req.body
		);

		try {
			const queueId = await wabaWebhookQueueService.enqueue(instance, req.body);
			processingLogger.log("Webhook WABA enfileirado para processamento", { queueId, instance });
			processingLogger.success({ status: "enqueued", queueId, instance });
			res.status(200).send();
		} catch (err: any) {
			processingLogger.failed(err);
			Logger.error("Erro ao enfileirar webhook WABA", err as Error);
			if (!res.headersSent) {
				res.status(200).send();
			}
		}
	};

	private webhookChallenge = async (req: Request, res: Response) => {
		try {
			const mode = req.query["hub.mode"];
			const token = req.query["hub.verify_token"];
			const challenge = req.query["hub.challenge"];
			const instance = req.params["instance"] as string;

			console.log(token);
			console.log(process.env["WABA_WEBHOOK_TOKEN"]);
			if (mode === "subscribe" && token === process.env["WABA_WEBHOOK_TOKEN"]) {
				Logger.info("WABA Webhook verified successfully for instance " + instance);
				res.status(200).send(challenge);
				return;
			}

			res.status(200).send();
		} catch (err: any) {
			const statusCode = err?.statusCode || err?.status || 500;
			Logger.error("Erro no webhook WABA challenge", err as Error);
			res.status(statusCode).send({
				message: err?.message,
				name: err?.name,
				stack: err?.stack
			});
		}
	};
}

export default new WABAController(Router());
