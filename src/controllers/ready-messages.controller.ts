import { Request, Response, Router } from "express";
import { BadRequestError } from "@rgranatodutra/http-errors";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import upload from "../middlewares/multer.middleware";
import readyMessagesService from "../services/ready-messages.service";

class ReadyMessagesController {
	constructor(public readonly router: Router) {
		this.router = Router();

		// Cria um ready message
		this.router.post(
			"/api/ready-messages",
			isAuthenticated,
			upload.single("file"),
			this.createReadyMessage
		);

		// Obtem ready-messages
		this.router.get(
			"/api/ready-messages",
			isAuthenticated,
			this.getReadyMessages
		);

		// Deletar ready-messages
		this.router.delete(
			"/api/ready-messages/:id",
			isAuthenticated,
			this.deleteReadyMessage
		);

		// Atualiza ready-messages
		this.router.put(
			"/api/ready-messages/:id",
			isAuthenticated,
			upload.single("file"),
			this.updateReadyMessage
		);

	}

	private async createReadyMessage(req: Request, res: Response) {
		const session = req.session;

		const body = JSON.parse(req.body.data);

		const TITULO = body.TITULO;
		const TEXTO_MENSAGEM = body.TEXTO_MENSAGEM;
		const SETOR = body.SETOR || null;
		console.log("[TITULO]",TITULO,req.file )
		const result = await readyMessagesService.createReadyMessage(
			session,
			{
				SETOR: SETOR,
				TEXTO_MENSAGEM: TEXTO_MENSAGEM,
				TITULO: TITULO
			},
			req.file || null
		);

		res.status(200).send({
			message: "ready message created successfully!",
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
		const groupId = Number(req.params["id"]);
		const file = req.file;

		if (!file) {
			throw new BadRequestError("File is required");
		}

		const updated = await readyMessagesService.updateReadyMessage(
			req.session,
			groupId,
			{},
			file
		);

		res.status(200).send({
			message: "ReadyMessage updated!",
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
