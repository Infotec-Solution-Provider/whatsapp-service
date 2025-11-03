import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import whatsappService from "../services/whatsapp.service";

class WhatsappController {
	constructor(public readonly router: Router) {
		this.router.get("/api/whatsapp/:clientId/groups", isAuthenticated, this.getGroups);
		this.router.get("/api/whatsapp/:clientId/templates", isAuthenticated, this.getTemplates);
		this.router.post("/api/whatsapp/:clientId/templates/send", isAuthenticated, this.sendTemplate);
		this.router.get("/api/whatsapp/sector/:sectorId/clients", isAuthenticated, this.getClients);
	}

	private async getClients(req: Request, res: Response) {
		const clients = await whatsappService.getClientsBySector(Number(req.params["sectorId"]));

		res.status(200).json({
			message: "Clients retrieved successfully!",
			data: clients
		});
	}

	private async getGroups(req: Request, res: Response) {
		const clientId = Number(req.params["clientId"]);
		const groups = await whatsappService.getGroups(clientId);

		res.status(200).json({
			message: "Groups retrieved successfully!",
			data: groups
		});
	}

	private async getTemplates(req: Request, res: Response) {
		const clientId = Number(req.params["clientId"]);
		const templates = await whatsappService.getTemplates(clientId);

		res.status(200).json({ templates });
	}

	private async sendTemplate(req: Request, res: Response) {
		try {
			const clientId = Number(req.params["clientId"]);
			const session = req.session;
			const { chatId, contactId, data, to } = req.body;

			await whatsappService.sendTemplate(session, clientId, to, data, chatId, contactId);

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
