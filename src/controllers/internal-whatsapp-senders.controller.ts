import { BadRequestError } from "@rgranatodutra/http-errors";
import { Request, Response, Router } from "express";
import isAdmin from "../middlewares/is-admin.middleware";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import internalWhatsappSendersService from "../services/internal-whatsapp-senders.service";

class InternalWhatsappSendersController {
	constructor(public readonly router: Router) {
		this.router = Router();
		this.router.get("/api/internal/whatsapp-senders/names", isAuthenticated, this.listNames);
		this.router.get("/api/internal/whatsapp-senders/messages", isAuthenticated, isAdmin, this.listMessages);
		this.router.put("/api/internal/whatsapp-senders/name", isAuthenticated, isAdmin, this.assignName);
		this.router.get("/api/internal/whatsapp-senders", isAuthenticated, isAdmin, this.listUnidentified);
	}

	private async listUnidentified(req: Request, res: Response) {
		const page = Math.max(Math.trunc(Number(req.query["page"])) || 1, 1);
		const perPage = Math.min(Math.max(Math.trunc(Number(req.query["perPage"])) || 20, 1), 100);
		const search = String(req.query["search"] ?? "")
			.trim()
			.slice(0, 191);
		const data = await internalWhatsappSendersService.listUnidentified(req.session.instance, {
			page,
			perPage,
			search
		});

		res.status(200).send({ message: "Remetentes sem nome obtidos com sucesso.", data });
	}

	private async listNames(req: Request, res: Response) {
		const data = await internalWhatsappSendersService.listNames(req.session);

		res.status(200).send({ message: "Nomes de remetentes obtidos com sucesso.", data });
	}

	private async listMessages(req: Request, res: Response) {
		const senderId = String(req.query["senderId"] ?? "").trim();
		const limit = Math.min(Math.max(Math.trunc(Number(req.query["limit"])) || 50, 1), 100);
		const beforeId = req.query["beforeId"] ? Number(req.query["beforeId"]) : null;

		if (!senderId) {
			throw new BadRequestError("O ID do remetente é obrigatório.");
		}

		if (beforeId !== null && (!Number.isInteger(beforeId) || beforeId <= 0)) {
			throw new BadRequestError("beforeId deve ser um número inteiro positivo.");
		}

		const data = await internalWhatsappSendersService.listMessages(req.session.instance, {
			senderId,
			limit,
			beforeId
		});

		res.status(200).send({ message: "Mensagens do remetente obtidas com sucesso.", data });
	}

	private async assignName(req: Request, res: Response) {
		const senderId = typeof req.body.senderId === "string" ? req.body.senderId.trim() : "";
		const displayName = typeof req.body.name === "string" ? req.body.name : "";

		if (!senderId) {
			throw new BadRequestError("O ID do remetente é obrigatório.");
		}

		const data = await internalWhatsappSendersService.assignName(
			req.session.instance,
			senderId,
			displayName,
			req.session.userId
		);

		res.status(200).send({ message: "Nome atribuído com sucesso.", data });
	}
}

export default new InternalWhatsappSendersController(Router());
