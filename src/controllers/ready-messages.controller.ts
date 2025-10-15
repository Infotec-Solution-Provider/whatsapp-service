import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import upload from "../middlewares/multer.middleware";
import readyMessagesService from "../services/ready-messages.service";

class ReadyMessagesController {
	constructor(public readonly router: Router) {
		this.router = Router();

		// Cria um ready message
		this.router.post("/api/ready-messages", isAuthenticated, upload.single("file"), this.createReadyMessage);

		// Obtem ready-messages
		this.router.get("/api/ready-messages", isAuthenticated, this.getReadyMessages);

		// Deletar ready-messages
		this.router.delete("/api/ready-messages/:id", isAuthenticated, this.deleteReadyMessage);

		// Atualiza ready-messages
		this.router.put("/api/ready-messages/:id", isAuthenticated, upload.single("file"), this.updateReadyMessage);
	}

	private async createReadyMessage(req: Request, res: Response) {
		const session = req.session;
		const body = JSON.parse(req.body.data);

		const { title, message, sectorIdFromBody, onlyAdmin } = body;
		const isTI = session.sectorId === 3;

		const sectorId = isTI ? Number(sectorIdFromBody) : session.sectorId;

		const result = await readyMessagesService.createReadyMessage(
			session,
			{
				sectorId,
				title,
				message,
				onlyAdmin: onlyAdmin || false
			},
			req.file || null
		);

		res.status(200).send({
			message: "Ready message created successfully!",
			data: result
		});
	}

	private async getReadyMessages(req: Request, res: Response) {
		const data = await readyMessagesService.getReadyMessages(req.session);

		res.status(200).send({
			message: "Ready Messages retrieved successfully!",
			data
		});
	}

	private async updateReadyMessage(req: Request, res: Response) {
		const id = Number(req.params["id"]);
		const file = req.file;
		const body = req.body.data ? JSON.parse(req.body.data) : {};

		const { TITULO: title, TEXTO_MENSAGEM: message, APENAS_ADMIN: onlyAdmin } = body;

		const updated = await readyMessagesService.updateReadyMessage(
			req.session,
			id,
			{
				...(title && { title }),
				...(message && { message }),
				...(onlyAdmin !== undefined && { onlyAdmin })
			},
			file
		);

		res.status(200).send({
			message: "Ready message updated!",
			data: updated
		});
	}

	private async deleteReadyMessage(req: Request, res: Response) {
		const id = Number(req.params["id"]);

		await readyMessagesService.deleteReadyMessage(req.session, id);

		res.status(200).send({
			message: "Ready Message deleted successfully!"
		});
	}
}

export default new ReadyMessagesController(Router());
