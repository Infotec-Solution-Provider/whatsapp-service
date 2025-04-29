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
		this.router.post(
			"/api/whatsapp/chats",
			isAuthenticated,
			this.startChatByContactId
		);
		this.router.get(
			"/api/whatsapp/session/monitor",
			isAuthenticated,
			this.getChatsMonitor
		);
		this.router.get(
			"/api/whatsapp/chats/:id/transfer",
			isAuthenticated,
			this.transferAttendance
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

	private async getChatsMonitor(req: Request, res: Response) {
		const includeMessages = Boolean(req.query["messages"] === "true");
		const includeContact = Boolean(req.query["contact"] === "true");

		const data = await chatsService.getChatsMonitor(
			req.session,
			includeMessages,
			includeContact
		);

		res.status(200).send({
			message: "Chats Monitor retrieved successfully!",
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
	private async transferAttendance(req: Request, res: Response) {
		const { id } = req.params;
		const userId = req.body.resultId;

		if (!id || isNaN(Number(id))) {
			throw new BadRequestError("Chat ID is required!");
		}

		if (!userId || isNaN(Number(userId))) {
			throw new BadRequestError("User ID is required!");
		}

		const session = req.session;

		await chatsService.transferAttendance(
			req.headers["authorization"] as string,
			session,
			Number(id),
			+userId
		);

		res.status(200).send({
			message: "Attendance transfer successfully!"
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

	private async startChatByContactId(req: Request, res: Response) {
		const contactId = +req.body.contactId;
		const session = req.session;

		if (Number.isNaN(contactId)) {
			throw new BadRequestError("Contact ID is required!");
		}

		const result = await chatsService.startChatByContactId(
			session,
			req.headers["authorization"] as string,
			contactId
		);

		res.status(200).send({
			message: "Chat started successfully!",
			data: result
		});
	}
}

export default new ChatsController(Router());
