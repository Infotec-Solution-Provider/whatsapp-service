import { Request, Response, Router } from "express";
import whatsappService from "../services/whatsapp.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import { WABAMessageStatusData } from "../types/whatsapp-api.types";
import { BadRequestError } from "@rgranatodutra/http-errors";
import GUPSHUPMessageParser from "../parsers/gupshup-message.parser";
import messagesService from "../services/messages.service";
import messagesDistributionService from "../services/messages-distribution.service";
import prismaService from "../services/prisma.service";

async function validateWebhookEntry(instance: string, data: any) {
	if (!data?.entry[0]?.changes[0]?.value) {
		throw new BadRequestError("invalid webhook entry.");
	}

	console.dir(data, { depth: null });
	const recipient =
		data.entry[0].changes[0].value.metadata.display_phone_number;

	if (data.entry[0].changes[0].value?.statuses?.[0]) {
		const statusChange = data.entry[0].changes[0].value.statuses[0];
		console.log("statusChange", statusChange);
		return {
			type: "status" as const,
			data: statusChange as WABAMessageStatusData,
			recipient
		};
	}

	if (data.entry[0].changes[0].value?.messages?.[0]) {
		const message = await GUPSHUPMessageParser.parse(
			recipient,
			instance,
			data.entry[0].changes[0].value.messages[0]
		);

		return { type: "message" as const, data: message, recipient };
	}

	return null;
}

class WhatsappController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/groups",
			isAuthenticated,
			this.getGroups
		);

		this.router.get(
			"/api/whatsapp/templates",
			isAuthenticated,
			this.getTemplates
		);

		this.router.post(
			"/api/whatsapp/meta/:instance/webhooks",
			this.receiveMessage
		);
		this.router.get("/api/whatsapp/meta/:instance/webhooks", this.webhook);
	}

	private async getGroups(req: Request, res: Response) {
		const groups = await whatsappService.getGroups(
			req.session.instance,
			req.session.sectorId
		);

		res.status(200).json({
			message: "Groups retrieved successfully!",
			data: groups
		});
	}

	private async getTemplates(req: Request, res: Response) {
		const templates = await whatsappService.getTemplates(req.session);

		res.status(200).json({ templates });
	}

	private async receiveMessage(req: Request, res: Response) {
		try {
			const instance = req.params["instance"] as string;
			const entry = await validateWebhookEntry(instance, req.body);

			if (!entry) {
				res.status(200).send();
				return;
			}

			const { type, data, recipient } = entry;

			const client = await prismaService.wppClient.findFirstOrThrow({
				where: {
					phone: recipient
				}
			});

			switch (type) {
				case "message":
					const savedMsg = await messagesService.insertMessage(data);
					await messagesDistributionService.processMessage(
						instance,
						client.id,
						savedMsg
					);
					break;
				case "status":
					const status = GUPSHUPMessageParser.parseStatus(data);

					console.log("status parsed", status);

					await messagesDistributionService.processMessageStatus(
						"waba",
						data.id,
						status
					);
					break;
				default:
					break;
			}

			res.status(200).send();
		} catch (err) {
			console.error(err);
			res.status(500).send();
		}
	}

	private async webhook(req: Request, res: Response) {
		console.log("challenge body", req.body);
		console.log("challenge headers", req.headers);

		res.status(200).send();
	}
}

export default new WhatsappController(Router());
