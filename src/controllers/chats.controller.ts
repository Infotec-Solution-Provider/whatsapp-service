import { Request, Response, Router } from "express";
import chatsService, { PublicConversationsFilters } from "../services/chats.service";
import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import onlyLocal from "../middlewares/only-local.middleware";
import publicBiRateLimit from "../middlewares/public-bi-rate-limit.middleware";
import protectedRead from "../middlewares/protected-read";
import chatUserPreferencesService, { ChatPreferenceType } from "../services/chat-user-preferences.service";
import publicReportFieldsService from "../services/public-report-fields.service";
import transferHistoryService from "../services/transfer-history.service";
import { TemplateVariables } from "../types/whatsapp-api.types";
import {
	chatScopeFromSession,
	messagesScopeFromSession,
	parseOptionalInstance,
	parsePositiveInt
} from "../utils/chat-scope";

const parseOptionalPositiveInt = (value: unknown, field: string) => {
	if (value === undefined || value === "") return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new BadRequestError(`${field} must be a positive integer!`);
	return parsed;
};

/* Validação das rotas internas usadas pelo agente de IA (mensagens em português). */

const requireAgentRouteChatId = (value: unknown) => {
	const chatId = parsePositiveInt(value);
	if (chatId === null) throw new BadRequestError("Informe um ID de chat válido.");
	return chatId;
};

const requireAgentRouteInstance = (value: unknown) => {
	const instance = parseOptionalInstance(value);
	if (!instance) throw new BadRequestError("Informe a empresa do chat (instance).");
	return instance;
};

const requireAgentRoutePositiveInt = (value: unknown, field: string) => {
	const parsed = parsePositiveInt(value);
	if (parsed === null) throw new BadRequestError(`O campo ${field} deve ser um número inteiro positivo.`);
	return parsed;
};

/** Ausente ou nulo = null; presente precisa ser inteiro positivo. Nunca responde “Agent ID is required!”. */
const parseAgentRouteOptionalPositiveInt = (value: unknown, field: string) => {
	if (value === undefined || value === null) return null;
	return requireAgentRoutePositiveInt(value, field);
};

const parseAgentRouteOptionalText = (value: unknown, field: string) => {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new BadRequestError(`O campo ${field} deve ser um texto.`);
	return value.trim() || null;
};

const parseAgentRouteTemplateVariables = (value: unknown): TemplateVariables => {
	if (value === undefined || value === null) return {} as TemplateVariables;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new BadRequestError("O campo templateVariables deve ser um objeto com os valores das variáveis.");
	}

	const variables: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (raw === undefined || raw === null) {
			variables[key] = "";
		} else if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
			variables[key] = String(raw);
		} else {
			throw new BadRequestError(`A variável de template “${key}” deve ser um texto.`);
		}
	}

	return variables as unknown as TemplateVariables;
};

const parseAgentRouteComponents = (value: unknown) => {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new BadRequestError("O campo components deve ser uma lista de textos.");
	}
	return value as string[];
};

const parseDate = (value: unknown, field: string) => {
	if (value === undefined || value === "") return undefined;
	const parsed = new Date(String(value));
	if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${field} must be a valid date!`);
	return parsed;
};

class ChatsController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/conversations",
			publicBiRateLimit,
			isAuthenticated,
			this.getPublicConversations.bind(this)
		);
		this.router.get("/api/whatsapp/session/chats", isAuthenticated, protectedRead("chats.session", this.getChatsBySession));
		this.router.get("/api/whatsapp/chats/:id", isAuthenticated, this.getChatById.bind(this));
		this.router.get("/api/whatsapp/chats/:id/messages", isAuthenticated, this.getChatMessages.bind(this));
		this.router.get(
			"/api/whatsapp/conversations/:id",
			publicBiRateLimit,
			isAuthenticated,
			this.getPublicConversationById.bind(this)
		);
		this.router.get(
			"/api/whatsapp/conversations/:id/messages",
			publicBiRateLimit,
			isAuthenticated,
			this.getPublicConversationMessages.bind(this)
		);
		this.router.get("/api/whatsapp/transfers", publicBiRateLimit, isAuthenticated, this.getPublicTransfers.bind(this));
		this.router.get("/api/internal/whatsapp/chats/:id", onlyLocal, this.getInternalChatById.bind(this));
		this.router.get(
			"/api/internal/whatsapp/chats/:id/messages",
			onlyLocal,
			this.getInternalChatMessages.bind(this)
		);
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
		this.router.post(
			"/api/internal/whatsapp/chats/:id/agent-transfer",
			onlyLocal,
			this.transferChatByAgent.bind(this)
		);
		this.router.post("/api/internal/whatsapp/chats/:id/agent-finish", onlyLocal, this.finishChatByAgent.bind(this));
		this.router.post(
			"/api/internal/whatsapp/chats/:id/agent-send-template",
			onlyLocal,
			this.sendTemplateByAgent.bind(this)
		);
		this.router.post("/api/whatsapp/chats/:id/finish", isAuthenticated, this.finishChatById);
		this.router.post("/api/whatsapp/chats", isAuthenticated, this.startChatByContactId);
		this.router.get("/api/whatsapp/session/monitor", isAuthenticated, protectedRead("chats.monitor", this.getChatsMonitor));
		this.router.post("/api/whatsapp/chats/:id/transfer", isAuthenticated, this.transferAttendance);
		this.router.patch("/api/whatsapp/chat-preferences/:type/:id", isAuthenticated, this.updateChatPreference);
	}

	private async getPublicConversations(req: Request, res: Response) {
		const parsePositiveInt = (value: unknown, fallback: number) => {
			const parsed = Number(value);
			return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
		const finishedFrom = parseDate(req.query["finishedFrom"], "finishedFrom");
		const finishedTo = parseDate(req.query["finishedTo"], "finishedTo");
		const filters: PublicConversationsFilters = {
			page,
			limit,
			...(rawIsFinished === undefined ? {} : { isFinished: rawIsFinished === "true" }),
			...(userId === undefined ? {} : { userId }),
			...(sectorId === undefined ? {} : { sectorId }),
			...(contactId === undefined ? {} : { contactId }),
			...(search ? { search } : {}),
			...(startedFrom === undefined ? {} : { startedFrom }),
			...(startedTo === undefined ? {} : { startedTo }),
			...(finishedFrom === undefined ? {} : { finishedFrom }),
			...(finishedTo === undefined ? {} : { finishedTo })
		};

		const data = await chatsService.getPublicConversations(req.session, filters);
		res.status(200).send({ message: "Conversations retrieved successfully!", data });
	}

	private async getPublicConversationById(req: Request, res: Response) {
		const id = parseOptionalPositiveInt(req.params["id"], "id");
		if (id === undefined) throw new BadRequestError("id must be a positive integer!");

		const data = await chatsService.getPublicConversationById(req.session, id);
		res.status(200).send({ message: "Conversation retrieved successfully!", data });
	}

	private async getPublicTransfers(req: Request, res: Response) {
		const rawLimit = req.query["limit"];
		const limit = rawLimit === undefined || rawLimit === "" ? 100 : Number(rawLimit);
		const conversationId = parseOptionalPositiveInt(req.query["conversationId"], "conversationId");
		const afterId = parseOptionalPositiveInt(req.query["afterId"], "afterId");
		const transferredFrom = parseDate(req.query["transferredFrom"], "transferredFrom");
		const transferredTo = parseDate(req.query["transferredTo"], "transferredTo");

		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new BadRequestError("limit must be an integer between 1 and 100!");
		}
		if (conversationId === undefined && (!transferredFrom || !transferredTo)) {
			throw new BadRequestError("transferredFrom and transferredTo are required without conversationId!");
		}
		if (transferredFrom && transferredTo && transferredFrom > transferredTo) {
			throw new BadRequestError("transferredFrom must be before or equal to transferredTo!");
		}

		const data = await transferHistoryService.exportPublicTransfers(req.session.instance, {
			limit,
			...(conversationId === undefined ? {} : { conversationId }),
			...(afterId === undefined ? {} : { afterId }),
			...(transferredFrom === undefined ? {} : { transferredFrom }),
			...(transferredTo === undefined ? {} : { transferredTo })
		});
		res.status(200).send({ message: "Transfers retrieved successfully!", data });
	}

	private async getChatsBySession(req: Request) {
		const includeMessages = Boolean(req.query["messages"] === "true");
		const includeContact = Boolean(req.query["contact"] === "true");

		const data = await chatsService.getUserChatsBySession(req.session, includeMessages, includeContact);

		return {
			message: "Chats retrieved successfully!",
			data
		};
	}

	private async updateChatPreference(req: Request, res: Response) {
		const type = req.params["type"];
		const action = req.body?.action;
		if (type !== "wpp" && type !== "internal") throw new BadRequestError("Invalid chat type!");
		if (!["pin", "unpin", "read", "unread"].includes(action)) {
			throw new BadRequestError("Invalid chat preference action!");
		}

		const data = await chatUserPreferencesService.update(
			req.session,
			type as ChatPreferenceType,
			Number(req.params["id"]),
			action
		);
		res.status(200).send({ message: "Chat preference updated successfully!", data });
	}

	private async getChatsMonitor(req: Request) {
		const data = await chatsService.getChatsMonitor(req.session);

		return {
			message: "Chats Monitor retrieved successfully!",
			data
		};
	}
	private async getChatById(req: Request, res: Response) {
		const id = parsePositiveInt(req.params["id"]);

		if (id === null) {
			throw new BadRequestError("Chat ID is required!");
		}

		const chat = await chatsService.getChatById(id, chatScopeFromSession(req.session));

		if (!chat) {
			throw new NotFoundError("Chat não encontrado.");
		}

		res.status(200).send({
			message: "Chat retrieved successfully!",
			data: chat
		});
	}

	private async getChatMessages(req: Request, res: Response) {
		const data = await this.fetchChatMessagesPage(req);

		res.status(200).send({
			message: "Chat messages retrieved successfully!",
			data
		});
	}

	private async getPublicConversationMessages(req: Request, res: Response) {
		const data = await this.fetchChatMessagesPage(req);
		const messages = await publicReportFieldsService.withMessageReport(req.session.instance, data.messages);

		res.status(200).send({
			message: "Chat messages retrieved successfully!",
			data: { ...data, messages }
		});
	}

	private parseChatMessagesPageRequest(req: Request) {
		const chatId = Number(req.params["id"]);
		const limit = Math.min(Math.max(Math.trunc(Number(req.query["limit"])) || 50, 1), 100);
		const beforeId = req.query["beforeId"] ? Number(req.query["beforeId"]) : null;

		if (!Number.isInteger(chatId) || chatId <= 0) {
			throw new BadRequestError("Chat ID is required!");
		}

		if (beforeId !== null && (!Number.isInteger(beforeId) || beforeId <= 0)) {
			throw new BadRequestError("beforeId must be a positive integer!");
		}

		return { chatId, limit, beforeId };
	}

	private async fetchChatMessagesPage(req: Request) {
		const { chatId, limit, beforeId } = this.parseChatMessagesPageRequest(req);

		return chatsService.getChatMessagesPage(messagesScopeFromSession(req.session), chatId, limit, beforeId);
	}

	/** Página de mensagens para o agente de IA: mesmo contrato da rota autenticada, escopo só por tenant. */
	private async getInternalChatMessages(req: Request, res: Response) {
		const instance = parseOptionalInstance(req.query["instance"]);

		if (!instance) {
			throw new BadRequestError("Instance is required!");
		}

		const { chatId, limit, beforeId } = this.parseChatMessagesPageRequest(req);
		const data = await chatsService.getChatMessagesPage({ instance }, chatId, limit, beforeId);

		res.status(200).send({
			message: "Chat messages retrieved successfully!",
			data
		});
	}

	/**
	 * Sem `instance`, busca em todos os tenants e devolve o histórico inteiro do contato
	 * (ai-service antigo); `instance` restringe ao tenant e `messages=false` não carrega o histórico.
	 */
	private async getInternalChatById(req: Request, res: Response) {
		const id = parsePositiveInt(req.params["id"]);

		if (id === null) {
			throw new BadRequestError("Chat ID is required!");
		}

		const instance = parseOptionalInstance(req.query["instance"]);
		const withMessages = req.query["messages"] !== "false";
		const chat = await chatsService.getChatById(
			id,
			instance ? { instance } : undefined,
			withMessages ? {} : { withMessages: false }
		);

		if (!chat) {
			throw new NotFoundError(instance ? "Chat não encontrado." : "Chat not found!");
		}

		res.status(200).send({
			message: "Chat retrieved successfully!",
			data: chat
		});
	}

	private async ensureInternalActiveChat(req: Request, res: Response) {
		const { instance, contactId, agentId, systemMessage, sectorId, userId } = (req.body ?? {}) as Record<
			string,
			unknown
		>;

		if (typeof instance !== "string" || !instance.trim()) {
			throw new BadRequestError("Instance is required!");
		}

		if (!Number.isInteger(contactId) || Number(contactId) <= 0) {
			throw new BadRequestError("Contact ID is required!");
		}

		// Opcional: “Iniciar chat” do Assistente não tem agente. A mensagem de erro não pode ser
		// “Agent ID is required!”, que o ai-service novo interpreta como whatsapp-service antigo.
		const parsedAgentId = parseAgentRouteOptionalPositiveInt(agentId, "agentId");

		const data = await chatsService.ensureActiveChatForAgent({
			instance: instance.trim(),
			contactId: Number(contactId),
			agentId: parsedAgentId,
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
		const body = (req.body ?? {}) as Record<string, unknown>;
		const rawText = body["text"];
		const text = typeof rawText === "string" ? rawText : "";
		const clientId = typeof body["clientId"] === "number" ? body["clientId"] : null;
		const fileId = typeof body["fileId"] === "number" ? body["fileId"] : null;

		if (!chatId || Number.isNaN(chatId)) {
			throw new BadRequestError("Chat ID is required!");
		}

		if (!text.trim() && fileId === null) {
			throw new BadRequestError("Text or fileId is required!");
		}

		const agentId = parseAgentRouteOptionalPositiveInt(body["agentId"], "agentId");
		const instance = parseOptionalInstance(body["instance"]);

		const message = await chatsService.sendInternalAgentMessage(chatId, {
			clientId,
			text,
			fileId,
			agentId,
			instance
		});

		res.status(201).send({
			message: "Agent message sent successfully!",
			data: message
		});
	}

	private async transferChatByAgent(req: Request, res: Response) {
		const chatId = requireAgentRouteChatId(req.params["id"]);
		const body = (req.body ?? {}) as Record<string, unknown>;
		const instance = requireAgentRouteInstance(body["instance"]);
		const agentId = requireAgentRoutePositiveInt(body["agentId"], "agentId");
		const userId = requireAgentRoutePositiveInt(body["userId"], "userId");
		const agentName = parseAgentRouteOptionalText(body["agentName"], "agentName");
		const reason = parseAgentRouteOptionalText(body["reason"], "reason");

		const data = await chatsService.transferChatByAgent(chatId, { instance, agentId, agentName, userId, reason });

		res.status(200).send({
			message: "Atendimento transferido.",
			data
		});
	}

	private async finishChatByAgent(req: Request, res: Response) {
		const chatId = requireAgentRouteChatId(req.params["id"]);
		const body = (req.body ?? {}) as Record<string, unknown>;
		const instance = requireAgentRouteInstance(body["instance"]);
		const agentId = requireAgentRoutePositiveInt(body["agentId"], "agentId");
		const agentName = parseAgentRouteOptionalText(body["agentName"], "agentName");
		const reason = parseAgentRouteOptionalText(body["reason"], "reason");
		const rawResultId = body["resultId"];

		if (rawResultId !== undefined && rawResultId !== null && !Number.isSafeInteger(rawResultId)) {
			throw new BadRequestError("O campo resultId deve ser um número inteiro.");
		}

		await chatsService.finishChatByAgent(chatId, {
			instance,
			agentId,
			agentName,
			resultId: typeof rawResultId === "number" ? rawResultId : null,
			reason
		});

		res.status(200).send({
			message: "Atendimento finalizado."
		});
	}

	private async sendTemplateByAgent(req: Request, res: Response) {
		const chatId = requireAgentRouteChatId(req.params["id"]);
		const body = (req.body ?? {}) as Record<string, unknown>;
		const instance = requireAgentRouteInstance(body["instance"]);
		const agentId = requireAgentRoutePositiveInt(body["agentId"], "agentId");
		const clientId = parseAgentRouteOptionalPositiveInt(body["clientId"], "clientId");
		const templateName = parseAgentRouteOptionalText(body["templateName"], "templateName");
		const templateLanguage = parseAgentRouteOptionalText(body["templateLanguage"], "templateLanguage");

		if (!templateName) {
			throw new BadRequestError("Informe o nome do template (templateName).");
		}

		await chatsService.sendTemplateByAgent(chatId, {
			instance,
			agentId,
			clientId,
			templateName,
			templateLanguage,
			templateVariables: parseAgentRouteTemplateVariables(body["templateVariables"]),
			components: parseAgentRouteComponents(body["components"])
		});

		res.status(201).send({
			message: "Template enviado."
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
