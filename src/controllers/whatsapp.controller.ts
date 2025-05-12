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
}

export default new WhatsappController(Router());
