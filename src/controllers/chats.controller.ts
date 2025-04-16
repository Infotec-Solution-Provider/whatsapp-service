import { Request, Response, Router } from "express";
import chatsService from "../services/chats.service";
import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";

// Routes TODO:
// /api/whatsapp/chats
// /api/whatsapp/chats/:id

class ChatsController {
	constructor(public readonly router: Router) {
		this.router.get("/chats", this.getChats);
		this.router.get("/chats/:id", this.getChatById);
	}

	private async getChats(req: Request, res: Response) {
		const data = await chatsService.getUserChats(req.session);

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
