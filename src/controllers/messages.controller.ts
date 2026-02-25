import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { BadRequestError } from "@rgranatodutra/http-errors";
import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import upload from "../middlewares/multer.middleware";
import messagesService from "../services/messages.service";
import whatsappService from "../services/whatsapp.service";

class MessagesController {
	constructor(public readonly router: Router) {
		this.router.get("/api/whatsapp/messages/:id", this.getMessageById);
		this.router.patch("/api/whatsapp/messages/mark-as-read", isAuthenticated, this.readContactMessages);
		this.router.post("/api/whatsapp/:clientId/messages", upload.single("file"), isAuthenticated, this.sendMessage);
		this.router.post("/api/whatsapp/:clientId/messages/forward", isAuthenticated, this.forwardMessages.bind(this));
		this.router.get("/api/whatsapp/messages", isAuthenticated, this.fetchMessages);

		this.router.put("/api/whatsapp/:clientId/messages/:id", isAuthenticated, this.editMessage);
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
		try {
			const clientId = Number(req.params["clientId"]);
			const { to, ...data } = req.body;
			const file = req.file;

			if (file) {
				data.file = file;
			}

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

			res.status(201).send({
				message: "Message sent successfully!",
				data: message
			});
		} catch (error) {
			res.status(500).send({
				message: sanitizeErrorMessage(error),
				error: (error as Error).message
			});
		}
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
		const hasChatFilter = chatId !== undefined || contactId !== undefined;

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
