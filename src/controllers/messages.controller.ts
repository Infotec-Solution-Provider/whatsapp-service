import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { BadRequestError } from "@rgranatodutra/http-errors";
import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import onlyLocal from "../middlewares/only-local.middleware";
import upload from "../middlewares/multer.middleware";
import publicBiRateLimit from "../middlewares/public-bi-rate-limit.middleware";
import messagesService from "../services/messages.service";
import whatsappService from "../services/whatsapp.service";
import { createUploadTraceLogger, resolveUploadTraceId } from "../utils/file-upload-trace";

class MessagesController {
	constructor(public readonly router: Router) {
		this.router.get("/api/whatsapp/messages/export", publicBiRateLimit, isAuthenticated, this.exportMessages);
		this.router.get("/api/whatsapp/messages/:id", this.getMessageById);
		this.router.patch("/api/whatsapp/messages/mark-as-read", isAuthenticated, this.readContactMessages);
		this.router.post("/api/whatsapp/:clientId/messages", upload.single("file"), isAuthenticated, this.sendMessage);
		this.router.post("/api/internal/whatsapp/chats/:chatId/agent-message", onlyLocal, this.createAgentMessage);
		this.router.post("/api/internal/whatsapp/chats/:chatId/agent-send-message", onlyLocal, this.sendAgentMessage);
		this.router.post("/api/internal/whatsapp/chats/:chatId/agent-template-message", onlyLocal, this.createAgentTemplateMessage);
		this.router.post("/api/whatsapp/:clientId/messages/forward", isAuthenticated, this.forwardMessages.bind(this));
		this.router.get("/api/whatsapp/messages", publicBiRateLimit, isAuthenticated, this.fetchMessages);

		this.router.put("/api/whatsapp/:clientId/messages/:id", isAuthenticated, this.editMessage);
	}

	private async exportMessages(req: Request, res: Response) {
		const rawSentFrom = req.query["sentFrom"];
		const rawSentTo = req.query["sentTo"];
		const sentFrom = new Date(String(rawSentFrom || ""));
		const sentTo = new Date(String(rawSentTo || ""));
		const rawLimit = req.query["limit"];
		const limit = rawLimit === undefined || rawLimit === "" ? 100 : Number(rawLimit);
		const rawAfterId = req.query["afterId"];
		const afterId = rawAfterId === undefined || rawAfterId === "" ? undefined : Number(rawAfterId);

		if (Number.isNaN(sentFrom.getTime()) || Number.isNaN(sentTo.getTime())) {
			throw new BadRequestError("sentFrom and sentTo must be valid dates!");
		}

		if (sentFrom > sentTo) {
			throw new BadRequestError("sentFrom must be before or equal to sentTo!");
		}

		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new BadRequestError("limit must be an integer between 1 and 100!");
		}

		if (afterId !== undefined && (!Number.isInteger(afterId) || afterId <= 0)) {
			throw new BadRequestError("afterId must be a positive integer!");
		}

		const data = await messagesService.exportPublicMessages(req.session, {
			sentFrom,
			sentTo,
			limit,
			...(afterId === undefined ? {} : { afterId })
		});

		res.status(200).send({
			message: "Messages exported successfully!",
			data
		});
	}

	private async getMessageById(req: Request, res: Response) {
		const { id } = req.params;

		if (!id) {
			throw new BadRequestError("Message ID is required!");
		}

		const data = await messagesService.getMessageById(req.session, +id);

		if (!data) {
			throw new BadRequestError("Message not found!");
		}

		res.status(200).send({
			message: "Message retrieved successfully!",
			data
		});
	}

	private async readContactMessages(req: Request, res: Response) {
		const contactId = req.body.contactId;

		if (!contactId) {
			throw new BadRequestError("Contact ID is required!");
		}

		const updatedData = await messagesService.markContactMessagesAsRead(req.session.instance, contactId);

		res.status(200).send({
			message: "Messages marked as read successfully!",
			data: updatedData
		});
	}

	private async sendMessage(req: Request, res: Response) {
		const traceId = resolveUploadTraceId(req.body.traceId, req.headers["x-upload-trace-id"]);
		const trace = createUploadTraceLogger("whatsapp-service.controller.messages", traceId);
		try {
			const clientId = Number(req.params["clientId"]);
			const { to, ...data } = req.body;
			const file = req.file;
			trace.info("request.received", {
				clientId,
				to,
				hasFile: !!file,
				fileId: data.fileId,
				fileName: file?.originalname,
				fileSize: file?.size,
				fileType: file?.mimetype,
			});

			if (file) {
				data.file = file;
			}
			data.traceId = traceId;

			// Convert string boolean values to actual booleans
			if (typeof data.sendAsDocument === 'string') {
				data.sendAsDocument = data.sendAsDocument === 'true';
			}
			if (typeof data.sendAsAudio === 'string') {
				data.sendAsAudio = data.sendAsAudio === 'true';
			}
			if (typeof data.isForwarded === 'string') {
				data.isForwarded = data.isForwarded === 'true';
			}

			const message = await whatsappService.sendMessage(req.session, clientId, to, data);
			trace.info("request.completed", {
				messageId: message.id,
				status: message.status,
				fileId: message.fileId,
			});

			res.status(201).send({
				message: "Message sent successfully!",
				data: message
			});
		} catch (error) {
			trace.error("request.failed", error, {
				clientId: req.params["clientId"],
				to: req.body.to,
				hasFile: !!req.file,
			});
			res.status(500).send({
				message: sanitizeErrorMessage(error),
				error: (error as Error).message
			});
		}
	}

	private async createAgentMessage(req: Request, res: Response) {
		const chatId = Number(req.params["chatId"]);
		const { text, agentId } = req.body as Record<string, unknown>;

		if (!Number.isInteger(chatId) || chatId <= 0) {
			throw new BadRequestError("Chat ID is required!");
		}

		if (typeof text !== "string" || !text.trim()) {
			throw new BadRequestError("Text is required!");
		}

		if (!Number.isInteger(agentId) || Number(agentId) <= 0) {
			throw new BadRequestError("Agent ID is required!");
		}

		const message = await whatsappService.createSimulatedAgentMessage(chatId, text.trim(), Number(agentId));

		res.status(201).send({
			message: "Message created successfully!",
			data: message,
		});
	}

	private async sendAgentMessage(req: Request, res: Response) {
		const chatId = Number(req.params["chatId"]);
		const { text, agentId, clientId } = req.body as Record<string, unknown>;

		if (!Number.isInteger(chatId) || chatId <= 0) {
			throw new BadRequestError("Chat ID is required!");
		}

		if (typeof text !== "string" || !text.trim()) {
			throw new BadRequestError("Text is required!");
		}

		if (!Number.isInteger(agentId) || Number(agentId) <= 0) {
			throw new BadRequestError("Agent ID is required!");
		}

		const message = await whatsappService.sendAgentMessage(
			chatId,
			text.trim(),
			Number(agentId),
			typeof clientId === "number" && Number.isInteger(clientId) && clientId > 0 ? clientId : null,
		);

		res.status(201).send({
			message: "Message sent successfully!",
			data: message,
		});
	}

	private async createAgentTemplateMessage(req: Request, res: Response) {
		const chatId = Number(req.params["chatId"]);
		const { agentId, templateName, templateLanguage } = req.body as Record<string, unknown>;

		if (!Number.isInteger(chatId) || chatId <= 0) {
			throw new BadRequestError("Chat ID is required!");
		}

		if (!Number.isInteger(agentId) || Number(agentId) <= 0) {
			throw new BadRequestError("Agent ID is required!");
		}

		if (typeof templateName !== "string" || !templateName.trim()) {
			throw new BadRequestError("Template name is required!");
		}

		const message = await whatsappService.createSimulatedAgentTemplateMessage(
			chatId,
			Number(agentId),
			templateName.trim(),
			typeof templateLanguage === "string" && templateLanguage.trim() ? templateLanguage.trim() : null,
		);

		res.status(201).send({
			message: "Message created successfully!",
			data: message,
		});
	}
	private async forwardMessages(req: Request, res: Response) {
		const clientId = Number(req.params["clientId"]);
		const { messageIds, whatsappTargets, internalTargets, sourceType } = req.body;

		if (!Array.isArray(messageIds) || messageIds.length === 0) {
			throw new BadRequestError("O campo 'messageIds' deve ser um array com pelo menos um ID de mensagem.");
		}

		const hasWhatsappTargets = Array.isArray(whatsappTargets) && whatsappTargets.length > 0;
		const hasInternalTargets = Array.isArray(internalTargets) && internalTargets.length > 0;

		if (!hasWhatsappTargets && !hasInternalTargets) {
			throw new BadRequestError(
				"É necessário fornecer ao menos um alvo de destino (whatsappTargets ou internalTargets)."
			);
		}

		/* 		await messageForwardingService.forwardMessages({
			session: req.session,
			messageIds,
			sourceType,
			whatsappTargets
		}); */
		await whatsappService.forwardMessages(
			req.session,
			clientId,
			messageIds,
			sourceType,
			whatsappTargets,
			internalTargets
		);

		res.status(200).send({
			message: "Mensagens enviadas para a fila de encaminhamento com sucesso!"
		});
	}

	private fetchMessages = async (req: Request, res: Response) => {
		const { minDate, maxDate, userId, chatId, contactId } = req.query;

		const hasDateFilters = minDate && maxDate;
		const hasChatFilter = chatId|| contactId;

		if (!hasDateFilters && !hasChatFilter) {
			throw new BadRequestError("Min and Max date are required for multi-chats report!");
		}

		if (hasDateFilters && (typeof minDate !== "string" || typeof maxDate !== "string")) {
			throw new BadRequestError("Min and Max date must be strings!");
		}

		const messages = await messagesService.fetchMessages(req.session, {
			minDate: String(minDate),
			maxDate: String(maxDate),
			userId: userId ? Number(userId) : null,
			chatId: chatId ? Number(chatId) : null,
			contactId: contactId ? Number(contactId) : null
		});

		res.status(200).send({
			message: "Messages retrieved successfully!",
			data: messages
		});
	};

	private async editMessage(req: Request, res: Response) {
		const { id } = req.params;
		const { newText } = req.body;

		if (!id) {
			throw new BadRequestError("Message ID is required!");
		}
		if (!newText || typeof newText !== "string" || newText.trim() === "") {
			throw new BadRequestError("New message body is required!");
		}

		const updatedMessage = await messagesService.editMessage({
			options: {
				messageId: Number(id),
				text: newText
			},
			session: req.session
		});

		res.status(200).send({
			message: "Message edited successfully!",
			data: updatedMessage
		});
	}
}

export default new MessagesController(Router());
