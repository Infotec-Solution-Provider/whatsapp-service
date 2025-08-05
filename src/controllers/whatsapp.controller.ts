import { Request, Response, Router } from "express";
import whatsappService from "../services/whatsapp.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import { WABAMessageStatusData } from "../types/whatsapp-api.types";
import { BadRequestError } from "@rgranatodutra/http-errors";
import { WABAMessage } from "../adapters/waba-message.adapter";

function validateWebhookEntry(data: any) {
	if (!data?.entry[0]?.changes[0]?.value) {
		throw new BadRequestError("invalid webhook entry.");
	}

	if (data.entry[0].changes[0].value?.statuses?.[0]) {
		const statusChange = data.entry[0].changes[0].value.statuses[0];

		return statusChange as WABAMessageStatusData;
	}

	if (data.entry[0].changes[0].value?.messages?.[0]) {
		console.log(new Date().toLocaleString() + " WABA Message: ");
		console.dir(data.entry[0].changes[0].value.messages[0], {
			depth: null
		});

		const message = WABAMessage.fromData(
			data.entry[0].changes[0].value.messages
		);

		return message;
	}

	throw new Error("unexpected webhook message format.");
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
		this.router.get("/api/whatsapp/meta/:instanc/webhooks", this.webhook);
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
		const data = validateWebhookEntry(req.body);

		console.log(data.id);

		res.status(200).send();
		res.status(500).send();
	}

	private async webhook(req: Request, res: Response) {
		console.log("challenge body", req.body);
		console.log("challenge headers", req.headers);

		res.status(200).send();
		res.status(500).send();
	}
}

export default new WhatsappController(Router());
