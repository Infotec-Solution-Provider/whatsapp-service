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
			"/api/whatsapp/messages/template",
			isAuthenticated,
			this.sendTemplate
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

		Object.keys(data).forEach((key) => {
			if (data[key] === undefined) {
				delete data[key];
			}
		});

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

	private async sendTemplate(req: Request, res: Response) {
		const { to, ...data } = req.body;

		const message = await whatsappService.sendTemplate(
			req.session,
			to,
			data
		);

		res.status(201).send({
			message: "",
			data: message
		});
	}
}

export default new MessagesController(Router());
