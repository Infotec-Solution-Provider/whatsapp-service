import { Request, Response, Router } from "express";
import internalChatsService from "../services/internal-chats.service";
import { BadRequestError } from "@rgranatodutra/http-errors";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import upload from "../middlewares/multer.middleware";

class InternalChatsController {
	constructor(public readonly router: Router) {
		this.router = Router();

		// Cria um chat interno de grupo ou direto
		this.router.post(
			"/api/internal/chats",
			isAuthenticated,
			upload.single("file"),
			this.startInternalChat
		);

		// Obtem chats internos do usuário através da sessão
		this.router.get(
			"/api/internal/session/chats",
			isAuthenticated,
			this.getSessionInternalChats
		);

		// Obtem grupos internos
		this.router.get(
			"/api/internal/groups",
			isAuthenticated,
			this.getInternalGroups
		);

		// Deletar chat interno
		this.router.delete(
			"/api/internal/chats/:id",
			isAuthenticated,
			this.deleteInternalChat
		);

		// Envia mensagem para um chat interno
		this.router.post(
			"/api/internal/chats/:id/messages",
			isAuthenticated,
			upload.single("file"),
			this.sendMessageToChat
		);

		// Atualiza grupo interno
		this.router.put(
			"/api/internal/groups/:id",
			isAuthenticated,
			this.updateInternalGroup
		);

		// Atualiza imagem do grupo interno
		this.router.put(
			"/api/internal/groups/:id/image",
			isAuthenticated,
			upload.single("file"),
			this.updateInternalGroupImage
		);

		// Atualiza grupo interno
		this.router.put(
			"/api/internal/groups/:id/image",
			isAuthenticated,
			this.updateInternalGroup
		);

		this.router.patch(
			"/api/internal/chat/:id/mark-as-read",
			isAuthenticated,
			this.markChatAsRead
		);

		this.router.get(
			"/api/internal/monitor/chats",
			isAuthenticated,
			this.getInternalChatsMonitor
		);
	}

	private async startInternalChat(req: Request, res: Response) {
		const session = req.session;

		const body = JSON.parse(req.body.data);

		const participants = body.participants;
		const isGroup = Boolean(body.isGroup);
		const groupName = body.groupName || "";
		const groupId = body.groupId || null;

		if (
			!participants ||
			!Array.isArray(participants) ||
			!participants.every((v) => typeof v === "number")
		) {
			throw new BadRequestError(
				"Participants must be an array of numbers"
			);
		}

		if (isGroup && groupName.length < 1) {
			throw new BadRequestError("Group name is required for group chats");
		}

		const result = await internalChatsService.createInternalChat(
			session,
			participants,
			isGroup,
			groupName,
			groupId,
			req.file || null
		);

		res.status(200).send({
			message: "Internal chat started successfully!",
			data: result
		});
	}

	private async getInternalChatsMonitor(req: Request, res: Response) {
		const data = await internalChatsService.getInternalChatsMonitor(
			req.session
		);

		res.status(200).send({
			message: "Internal chats retrieved successfully!",
			data
		});
	}
	private async getSessionInternalChats(req: Request, res: Response) {
		const data = await internalChatsService.getInternalChatsBySession(
			req.session
		);

		res.status(200).send({
			message: "Internal chats retrieved successfully!",
			data
		});
	}

	private async getInternalGroups(req: Request, res: Response) {
		const data = await internalChatsService.getInternalGroups(req.session);

		res.status(200).send({
			message: "Internal chats retrieved successfully!",
			data
		});
	}

	private async sendMessageToChat(req: Request, res: Response) {
		const data = { ...req.body, file: req.file || null };
		await internalChatsService.sendMessage(req.session, data);

		res.status(201).send({ message: "Message sent successfully!" });
	}

	private async updateInternalGroup(req: Request, res: Response) {
		const groupId = Number(req.params["id"]);

		const updated = await internalChatsService.updateInternalGroup(
			groupId,
			req.body
		);

		res.status(200).send({
			message: "Group members updated!",
			data: updated
		});
	}

	private async updateInternalGroupImage(req: Request, res: Response) {
		const groupId = Number(req.params["id"]);
		const file = req.file;

		if (!file) {
			throw new BadRequestError("File is required");
		}

		const updated = await internalChatsService.updateGroupImage(
			req.session,
			groupId,
			file
		);

		res.status(200).send({
			message: "Group image updated!",
			data: updated
		});
	}

	//delete internal chat (Only if is group)
	private async deleteInternalChat(req: Request, res: Response) {
		const chatId = Number(req.params["id"]);

		await internalChatsService.deleteInternalChat(chatId);

		res.status(200).send({
			message: "Chat deleted successfully!"
		});
	}

	private async markChatAsRead(req: Request, res: Response) {
		const chatId = Number(req.params["id"]);

		await internalChatsService.markChatMessagesAsRead(
			chatId,
			req.session.userId
		);

		res.status(200).send({
			message: "Chat marked as read!"
		});
	}
}

export default new InternalChatsController(Router());
