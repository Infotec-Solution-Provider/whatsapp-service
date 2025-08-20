import { Request, Response, Router } from "express";
import whatsappService from "../services/whatsapp.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
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
			"/api/whatsapp/templates/send",
			isAuthenticated,
			this.sendTemplate
		);
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

	private async sendTemplate(req: Request, res: Response) {
		try {
			const session = req.session;
			const { chatId, contactId, data, to } = req.body;

			await whatsappService.sendTemplate(
				session,
				to,
				data,
				chatId,
				contactId
			);

			res.status(201).send();
		} catch (err: any) {
			res.status(500).send({
				message: "failed to send template",
				error: err?.message || err
			});
		}
	}
}

export default new WhatsappController(Router());
