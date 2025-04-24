import { Request, Response, Router } from "express";
import chatsService from "../services/chats.service";
import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import isAuthenticated from "../middlewares/is-authenticated.middleware";

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
		this.router.post(
			"/api/whatsapp/chats/:id/finish",
			isAuthenticated,
			this.finishChatById
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

	private async finishChatById(req: Request, res: Response) {
		const { id } = req.params;
		const resultId = req.body.resultId;

		if (!id || isNaN(Number(id))) {
			throw new BadRequestError("Chat ID is required!");
		}

		if (!resultId || isNaN(Number(resultId))) {
			throw new BadRequestError("Result ID is required!");
		}

		const session = req.session;

		await chatsService.finishChatById(
			req.headers["authorization"] as string,
			session,
			Number(id),
			+resultId
		);

		res.status(200).send({
			message: "Chat finished successfully!"
		});
	}
}

export default new ChatsController(Router());
