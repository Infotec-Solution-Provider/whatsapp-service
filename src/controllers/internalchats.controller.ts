import { Request, Response, Router } from "express";
import internalChatsService from "../services/internalchats.service";
import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import isAuthenticated from "../middlewares/is-authenticated.middleware";

class InternalChatsController {
  constructor(public readonly router: Router) {
    this.router = Router();
	this.router.get(
		"/api/internal/session/chats",
		isAuthenticated,
		this.getChatsBySession
	);
	this.router.get(
		"/api/internal/contacts",
		isAuthenticated,
		this.getContactsWithUser
	);
    // Lista todos os chats internos (diretos + grupos) do usuário
    this.router.get(
      "/api/internal/chats",
      isAuthenticated,
      this.getChatsForUser
    );
    // Detalhes de um chat (inclui participantes se for grupo)
    this.router.get(
      "/api/internal/chats/:id",
      isAuthenticated,
      this.getChatById
    );
    // Envia mensagem para chat interno (direto ou grupo)
    this.router.post(
      "/api/internal/chats/:id/messages",
      isAuthenticated,
      this.sendMessageToChat
    );
    // Cria novo grupo interno
    this.router.post(
      "/api/internal/chats/group",
      isAuthenticated,
      this.createGroup
    );
    // Adiciona/Remove participante de grupo
    this.router.put(
      "/api/internal/chats/group/:id/members",
      isAuthenticated,
      this.updateGroupMembers
    );
	this.router.post(
		"/api/internal/chats",
		isAuthenticated,
		this.startInternalChatByContactId
	);
  }
	private async getChatsBySession(req: Request, res: Response) {
		const includeMessages = Boolean(req.query["messages"] === "true");
		const includeContact = Boolean(req.query["contact"] === "true");

		const data = await internalChatsService.getUserChatsBySession(
			req.session,
			includeMessages,
			includeContact
		);

		res.status(200).send({
			message: "Chats retrieved successfully!",
			data
		});
	}

	private async getContactsWithUser(req: Request, res: Response) {
		const data = await internalChatsService.getContactsWithUser(
			req.session.instance,
			req.headers["authorization"] as string
		);

		res.status(200).send({
			message: "Contacts retrieved successfully!",
			data
		});
	}

	private async startInternalChatByContactId(req: Request, res: Response) {
		const contactId = +req.body.contactId;
		const session = req.session;

		if (Number.isNaN(contactId)) {
			throw new BadRequestError("Contact ID is required!");
		}

		const result = await internalChatsService.startInternalChatByContactId(
			session,
			req.headers["authorization"] as string,
			contactId
		);

		res.status(200).send({
			message: "Chat started successfully!",
			data: result
		});
	}

  private async getChatsForUser(req: Request, res: Response) {
	const userId = req.query["userId"] as string;
	const instance = req.query["instance"] as string;

	if (!userId || !instance) {
		res.status(400).json({
			message: "Query params 'userId' and 'instance' are required"
		});
		return;
	}
    const chats = await internalChatsService.getChatsForUser(+userId);
    res.status(200).send({ message: "Internal chats retrieved successfully!", data: chats });
  }

  private async getChatById(req: Request, res: Response) {
    const chatId = Number(req.params['id']);
    if (isNaN(chatId)) throw new BadRequestError("Invalid chat ID");
    const chat = await internalChatsService.getChatById(chatId);
    if (!chat) throw new NotFoundError("Internal chat not found");
    res.status(200).send({ message: "Internal chat retrieved successfully!", data: chat });
  }

  private async sendMessageToChat(req: Request, res: Response) {
    const chatId = Number(req.params['id']);
    const { content } = req.body;
    if (!content) throw new BadRequestError("Message content is required");
	const userId = req.query["userId"] as string;
    await internalChatsService.sendMessage(chatId, +userId, content);
    res.status(201).send({ message: "Message sent successfully!" });
  }

  private async createGroup(req: Request, res: Response) {
    const { name, participantIds } = req.body;
    if (!name || !Array.isArray(participantIds)) {
      throw new BadRequestError("Group name and participantIds are required");
    }
	const userId = req.query["userId"] as string;
    const group = await internalChatsService.createGroup(name, +userId, participantIds);
    res.status(201).send({ message: "Group created successfully!", data: group });
  }

  private async updateGroupMembers(req: Request, res: Response) {
    const groupId = Number(req.params['id']);
    const { add = [], remove = [] } = req.body;
    if (isNaN(groupId)) throw new BadRequestError("Invalid group ID");
    const updated = await internalChatsService.updateGroupMembers(groupId, add, remove);
    res.status(200).send({ message: "Group members updated!", data: updated });
  }
}

export default new InternalChatsController(Router());

