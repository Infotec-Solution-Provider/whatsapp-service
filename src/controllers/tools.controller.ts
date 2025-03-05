import { Request, Response, Router } from "express";
import * as core from "express-serve-static-core";
import toolsService from "../services/tools-service";
import AuthMiddleware from "../middlewares/auth.middleware";

class ToolsController {
	public readonly router: core.Router;

	constructor() {
		this.router = Router();

		this.router.post(
			"/:instance/tools/export-chats",
			AuthMiddleware.isAdmin,
			this.exportChats
		);
		this.router.get(
			"/:instance/tools/export-chats",
			AuthMiddleware.isAdmin,
			this.getExportedChats
		);
	}

	private async exportChats(req: Request, res: Response): Promise<void> {
		try {
			await toolsService.exportChats({
				instance: req.params["instance"]!,
				...req.body
			});

			res.status(201).json({ message: "Successfully exported chat" });
		} catch (e: unknown) {
			res.status(500).json({
				message: e instanceof Error ? e.message : "Something went wrong"
			});
		}
	}

	private async getExportedChats(req: Request, res: Response): Promise<void> {
		try {
			const exports = await toolsService.getExportedChats(
				req.params["instance"]!
			);

			res.status(200).json({ exports });
		} catch (e: unknown) {
			res.status(500).json({
				message: e instanceof Error ? e.message : "Something went wrong"
			});
		}
	}
}

export default new ToolsController();
