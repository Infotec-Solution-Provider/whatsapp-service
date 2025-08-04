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

		this.router.post("/api/whatsapp/meta/webhooks", this.receiveMessage);
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
		console.log("GUP MESSAGE", req.body);

		res.status(500).send();
	}
}

export default new WhatsappController(Router());
