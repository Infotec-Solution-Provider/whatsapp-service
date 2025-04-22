import { Request, Response, Router } from "express";
import chatsService from "../services/chats.service";
import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import isAuthenticated from "../middlewares/is-authenticated.middleware";

// Routes TODO:
// /api/whatsapp/chats
// /api/whatsapp/chats/:id

class ChatsController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/session/chats",
			isAuthenticated,
			this.getChatsBySession
		);
		this.router.get(
			"/api/whatsapp/chats/:id",
			isAuthenticated,
			this.getChatById
		);
	}

	private async getChatsBySession(req: Request, res: Response) {
		const includeMessages = Boolean(req.query["messages"] === "true");
		const includeContact = Boolean(req.query["contact"] === "true");

		const data = await chatsService.getUserChatsBySession(
			req.session,
			includeMessages,
			includeContact
		);

		res.status(200).send({
			message: "Chats retrieved successfully!",
			data
		});
	}

	private async getChatById(req: Request, res: Response) {
		const { id } = req.params;

		if (!id) {
			throw new BadRequestError("Chat ID is required!");
		}

		const chat = await chatsService.getChatById(Number(id));

		if (!chat) {
			throw new NotFoundError("Chat not found!");
		}

		res.status(200).send({
			message: "Chat retrieved successfully!",
			data: chat
		});
	}
}

export default new ChatsController(Router());
