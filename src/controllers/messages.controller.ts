import { Request, Response, Router } from "express";
import messagesService from "../services/messages.service";
import { BadRequestError } from "@rgranatodutra/http-errors";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import whatsappService from "../services/whatsapp.service";
import upload from "../middlewares/multer.middleware";

class MessagesController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/messages/:id",
			isAuthenticated,
			this.getMessageById
		);
		this.router.patch(
			"/api/whatsapp/messages/mark-as-read",
			isAuthenticated,
			this.readContactMessages
		);
		this.router.post(
			"/api/whatsapp/messages",
			upload.single("file"),
			isAuthenticated,
			this.sendMessage
		);
		this.router.post(
			"/api/whatsapp/messages/forward",
			isAuthenticated,
			this.forwardMessages.bind(this)
		);
		this.router.get(
			"/api/whatsapp/messages",
			isAuthenticated,
			this.fetchMessages
		);
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

		const updatedData = await messagesService.markContactMessagesAsRead(
			req.session.instance,
			contactId
		);

		res.status(200).send({
			message: "Messages marked as read successfully!",
			data: updatedData
		});
	}

	private async sendMessage(req: Request, res: Response) {
		const { to, ...data } = req.body;
		const file = req.file;

		if (file) {
			data.file = file;
		}

		const message = await whatsappService.sendMessage(
			req.session,
			to,
			data
		);

		res.status(201).send({
			message: "Message sent successfully!",
			data: message
		});
	}
	private async forwardMessages(req: Request, res: Response) {
		const { messageIds, whatsappTargets, internalTargets, sourceType } =
			req.body;

		if (!Array.isArray(messageIds) || messageIds.length === 0) {
			throw new BadRequestError(
				"O campo 'messageIds' deve ser um array com pelo menos um ID de mensagem."
			);
		}

		const hasWhatsappTargets =
			Array.isArray(whatsappTargets) && whatsappTargets.length > 0;
		const hasInternalTargets =
			Array.isArray(internalTargets) && internalTargets.length > 0;

		if (!hasWhatsappTargets && !hasInternalTargets) {
			throw new BadRequestError(
				"É necessário fornecer ao menos um alvo de destino (whatsappTargets ou internalTargets)."
			);
		}

		await whatsappService.forwardMessages(
			req.session,
			messageIds,
			sourceType,
			whatsappTargets,
			internalTargets
		);

		res.status(200).send({
			message:
				"Mensagens enviadas para a fila de encaminhamento com sucesso!"
		});
	}

	private fetchMessages = async (req: Request, res: Response) => {
		const { minDate, maxDate, userId } = req.query;

		if (!minDate || !maxDate) {
			throw new BadRequestError("Min and Max date are required!");
		}

		if (typeof minDate !== "string" || typeof maxDate !== "string") {
			throw new BadRequestError("Min and Max date must be strings!");
		}

		const messages = await messagesService.fetchMessages(req.session, {
			minDate: String(minDate),
			maxDate: String(maxDate),
			userId: userId ? Number(userId) : null
		});

		res.status(200).send({
			message: "Messages retrieved successfully!",
			data: messages
		});
	};
}

export default new MessagesController(Router());
