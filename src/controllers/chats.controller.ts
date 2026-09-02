import { Request, Response, Router } from "express";
import chatsService, { PublicConversationsFilters } from "../services/chats.service";
import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import onlyLocal from "../middlewares/only-local.middleware";
import publicBiRateLimit from "../middlewares/public-bi-rate-limit.middleware";

class ChatsController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/conversations",
			publicBiRateLimit,
			isAuthenticated,
			this.getPublicConversations.bind(this)
		);
		this.router.get("/api/whatsapp/session/chats", isAuthenticated, this.getChatsBySession);
		this.router.get("/api/whatsapp/chats/:id", isAuthenticated, this.getChatById.bind(this));
		this.router.get("/api/whatsapp/chats/:id/messages", isAuthenticated, this.getChatMessages.bind(this));
		this.router.get(
			"/api/whatsapp/conversations/:id/messages",
			publicBiRateLimit,
			isAuthenticated,
			this.getChatMessages.bind(this)
		);
		this.router.get("/api/internal/whatsapp/chats/:id", onlyLocal, this.getInternalChatById.bind(this));
		this.router.post(
			"/api/internal/whatsapp/chats/:id/agent-send-message",
			onlyLocal,
			this.sendInternalAgentMessage.bind(this)
		);
		this.router.post(
			"/api/internal/whatsapp/chats/ensure-active",
			onlyLocal,
			this.ensureInternalActiveChat.bind(this)
		);
		this.router.post("/api/whatsapp/chats/:id/finish", isAuthenticated, this.finishChatById);
		this.router.post("/api/whatsapp/chats", isAuthenticated, this.startChatByContactId);
		this.router.get("/api/whatsapp/session/monitor", isAuthenticated, this.getChatsMonitor);
		this.router.post("/api/whatsapp/chats/:id/transfer", isAuthenticated, this.transferAttendance);
	}

	private async getPublicConversations(req: Request, res: Response) {
		const parsePositiveInt = (value: unknown, fallback: number) => {
			const parsed = Number(value);
			return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
		};
		const parseOptionalPositiveInt = (value: unknown, field: string) => {
			if (value === undefined || value === "") return undefined;
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed <= 0) throw new BadRequestError(`${field} must be a positive integer!`);
			return parsed;
		};
		const parseDate = (value: unknown, field: string) => {
			if (value === undefined || value === "") return undefined;
			const parsed = new Date(String(value));
			if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${field} must be a valid date!`);
			return parsed;
		};
		const rawIsFinished = req.query["isFinished"];

		if (rawIsFinished !== undefined && rawIsFinished !== "true" && rawIsFinished !== "false") {
			throw new BadRequestError("isFinished must be true or false!");
		}

		const page = parsePositiveInt(req.query["page"], 1);
		const limit = Math.min(parsePositiveInt(req.query["limit"], 25), 100);
		const userId = parseOptionalPositiveInt(req.query["userId"], "userId");
		const sectorId = parseOptionalPositiveInt(req.query["sectorId"], "sectorId");
		const contactId = parseOptionalPositiveInt(req.query["contactId"], "contactId");
		const search = typeof req.query["search"] === "string" ? req.query["search"].trim().slice(0, 120) : "";
		const startedFrom = parseDate(req.query["startedFrom"], "startedFrom");
		const startedTo = parseDate(req.query["startedTo"], "startedTo");
		const filters: PublicConversationsFilters = {
			page,
			limit,
			...(rawIsFinished === undefined ? {} : { isFinished: rawIsFinished === "true" }),
			...(userId === undefined ? {} : { userId }),
			...(sectorId === undefined ? {} : { sectorId }),
			...(contactId === undefined ? {} : { contactId }),
			...(search ? { search } : {}),
			...(startedFrom === undefined ? {} : { startedFrom }),
			...(startedTo === undefined ? {} : { startedTo })
		};

		const data = await chatsService.getPublicConversations(req.session, filters);
		res.status(200).send({ message: "Conversations retrieved successfully!", data });
	}

	private async getChatsBySession(req: Request, res: Response) {
		const includeMessages = Boolean(req.query["messages"] === "true");
		const includeContact = Boolean(req.query["contact"] === "true");

		const data = await chatsService.getUserChatsBySession(req.session, includeMessages, includeContact);

		res.status(200).send({
			message: "Chats retrieved successfully!",
			data
		});
	}

	private async getChatsMonitor(req: Request, res: Response) {
		const data = await chatsService.getChatsMonitor(req.session);

		res.status(200).send({
			message: "Chats Monitor retrieved successfully!",
			data
		});
	}
	private async getChatById(req: Request, res: Response) {
		return this.sendChatById(req, res);
	}

	private async getChatMessages(req: Request, res: Response) {
		const chatId = Number(req.params["id"]);
		const limit = Math.min(Math.max(Math.trunc(Number(req.query["limit"])) || 50, 1), 100);
		const beforeId = req.query["beforeId"] ? Number(req.query["beforeId"]) : null;

		if (!Number.isInteger(chatId) || chatId <= 0) {
			throw new BadRequestError("Chat ID is required!");
		}

		if (beforeId !== null && (!Number.isInteger(beforeId) || beforeId <= 0)) {
			throw new BadRequestError("beforeId must be a positive integer!");
		}

		const data = await chatsService.getChatMessagesPage(req.session, chatId, limit, beforeId);

		res.status(200).send({
			message: "Chat messages retrieved successfully!",
			data
		});
	}

	private async getInternalChatById(req: Request, res: Response) {
		return this.sendChatById(req, res);
	}

	private async sendChatById(req: Request, res: Response) {
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

	private async ensureInternalActiveChat(req: Request, res: Response) {
		const { instance, contactId, agentId, systemMessage, sectorId, userId } = req.body as Record<string, unknown>;

		if (typeof instance !== "string" || !instance.trim()) {
			throw new BadRequestError("Instance is required!");
		}

		if (!Number.isInteger(contactId) || Number(contactId) <= 0) {
			throw new BadRequestError("Contact ID is required!");
		}

		if (!Number.isInteger(agentId) || Number(agentId) <= 0) {
			throw new BadRequestError("Agent ID is required!");
		}

		const data = await chatsService.ensureActiveChatForAgent({
			instance: instance.trim(),
			contactId: Number(contactId),
			agentId: Number(agentId),
			...(typeof systemMessage === "string" ? { systemMessage } : {}),
			sectorId: Number.isInteger(sectorId) ? Number(sectorId) : null,
			userId: Number.isInteger(userId) ? Number(userId) : null
		});

		res.status(200).send({
			message: data.existed ? "Chat already active." : "Chat started successfully!",
			data
		});
	}

	private async sendInternalAgentMessage(req: Request, res: Response) {
		const chatId = Number(req.params["id"]);
		const rawText = req.body.text;
		const text = typeof rawText === "string" ? rawText : "";
		const clientId = typeof req.body.clientId === "number" ? req.body.clientId : null;
		const fileId = typeof req.body.fileId === "number" ? req.body.fileId : null;

		if (!chatId || Number.isNaN(chatId)) {
			throw new BadRequestError("Chat ID is required!");
		}

		if (!text.trim() && fileId === null) {
			throw new BadRequestError("Text or fileId is required!");
		}

		const message = await chatsService.sendInternalAgentMessage(chatId, {
			clientId,
			text,
			fileId
		});

		res.status(201).send({
			message: "Agent message sent successfully!",
			data: message
		});
	}

	private async transferAttendance(req: Request, res: Response) {
		const { id } = req.params;
		const userId = req.body.userId;

		if (!id || isNaN(Number(id))) {
			throw new BadRequestError("Chat ID is required!");
		}

		if (!userId || isNaN(Number(userId))) {
			throw new BadRequestError("User ID is required!");
		}

		const session = req.session;

		await chatsService.transferAttendance(req.headers["authorization"] as string, session, Number(id), +userId);

		res.status(200).send({
			message: "Attendance transfer successfully!"
		});
	}

	private async finishChatById(req: Request, res: Response) {
		const { id } = req.params;
		const resultId = req.body.resultId;
		const scheduleDate = req.body.scheduleDate ? new Date(req.body.scheduleDate) : null;

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
			+resultId,
			scheduleDate
		);

		res.status(200).send({
			message: "Chat finished successfully!"
		});
	}

	private async startChatByContactId(req: Request, res: Response) {
		const contactId = +req.body.contactId;
		const template = req.body.template;
		const session = req.session;

		if (Number.isNaN(contactId)) {
			throw new BadRequestError("Contact ID is required!");
		}

		const result = await chatsService.startChatByContactId(
			session,
			req.headers["authorization"] as string,
			contactId,
			template
		);

		res.status(200).send({
			message: "Chat started successfully!",
			data: result
		});
	}
}

export default new ChatsController(Router());
