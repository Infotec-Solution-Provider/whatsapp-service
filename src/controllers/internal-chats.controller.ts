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
			this.createInternalChat
		);

		// Obtem chats internos do usuário através da sessão
		this.router.get(
			"/api/internal/session/chats",
			isAuthenticated,
			this.getChatsBySession
		);

		// Envia mensagem para um chat interno
		this.router.post(
			"/api/internal/chats/:id/messages",
			isAuthenticated,
			upload.single("file"),
			this.sendMessageToChat
		);

		// Atualiza participantes de um grupo interno
		this.router.put(
			"/api/internal/chats/:id/participants",
			isAuthenticated,
			this.updateGroupParticipantes
		);
	}

	private async createInternalChat(req: Request, res: Response) {
		const session = req.session;

		const participants = req.body.participants;
		const isGroup = Boolean(req.body.isGroup);
		const groupName = req.body.groupName || "";

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
			groupName
		);

		res.status(200).send({
			message: "Internal chat started successfully!",
			data: result
		});
	}

	private async getChatsBySession(req: Request, res: Response) {
		const data = await internalChatsService.getInternalChatsBySession(
			req.session
		);

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

	private async updateGroupParticipantes(req: Request, res: Response) {
		const groupId = Number(req.params["id"]);
		const participants = req.body.participants as number[];

		const updated =
			await internalChatsService.updateInternalChatParticipants(
				groupId,
				participants
			);

		res.status(200).send({
			message: "Group members updated!",
			data: updated
		});
	}
}

export default new InternalChatsController(Router());
