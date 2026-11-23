import { Request, Response, Router, raw } from "express";
import prisma from "../services/prisma.service";
import queue from "../services/waba-webhook-queue.service";
import { check, verifySignature } from "../integrations/ciag/policy";
import { splitWebhook } from "../integrations/ciag/webhook";
const ENDPOINT = "/api/whatsapp/waba/:instance";
class WABAController {
	constructor(public readonly router: Router) {
		router.post(ENDPOINT + "/webhooks", raw({ type: "application/json", limit: "2mb" }), this.entry);
		router.get(ENDPOINT + "/webhooks", this.challenge);
	}
	private entry = async (req: Request, res: Response) => {
		try {
			check(Buffer.isBuffer(req.body), "Envie JSON.", 415);
			const input = JSON.parse(req.body.toString("utf8")) as unknown;
			const events = splitWebhook(input),
				instance = req.params["instance"] as string;
			const secrets = JSON.parse(process.env["WABA_APP_SECRETS"] || "{}") as Record<string, string>;
			const clients = await prisma.wppClient.findMany({ where: { instance, type: "WABA", isActive: true } });
			for (const event of events) {
				check(
					clients.some((c) => c.WABAPhoneId === event.phoneId && c.WABAAccountId === event.accountId),
					"Número não autorizado para esta instância.",
					403
				);
				check(
					verifySignature(
						req.body,
						req.headers["x-hub-signature-256"],
						secrets[event.phoneId] || process.env["WABA_APP_SECRET"] || ""
					),
					"Assinatura inválida.",
					403
				);
			}
			// Empty notifications are still authenticated before being acknowledged.
			if (!events.length)
				check(
					verifySignature(req.body, req.headers["x-hub-signature-256"], process.env["WABA_APP_SECRET"] || ""),
					"Assinatura inválida.",
					403
				);
			for (const event of events) await queue.enqueue(instance, event.payload);
			res.status(200).send();
		} catch (error) {
			const e = error as { status?: number };
			res.status(e.status ?? (error instanceof SyntaxError ? 400 : 503)).json({
				error: e.status === 403 ? "Webhook não autorizado." : "Webhook não recebido. Tente novamente."
			});
		}
	};
	private challenge = async (req: Request, res: Response) => {
		const token = process.env["WABA_WEBHOOK_TOKEN"];
		if (
			token &&
			req.query["hub.mode"] === "subscribe" &&
			req.query["hub.verify_token"] === token &&
			typeof req.query["hub.challenge"] === "string"
		)
			res.status(200).send(req.query["hub.challenge"]);
		else res.status(403).send();
	};
}
export default new WABAController(Router());
