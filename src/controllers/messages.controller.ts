import { Request, Response, Router } from "express";
import messagesService from "../services/messages.service";
import { BadRequestError } from "@rgranatodutra/http-errors";

class MessagesController {
	constructor(public readonly router: Router) {
		this.router.get("/messages/:id", this.getMessageById);
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
}

export default new MessagesController(Router());
