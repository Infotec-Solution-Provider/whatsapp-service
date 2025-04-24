import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import sectorsService from "../services/sectors.service";

class SectorsController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/sectors",
			isAuthenticated,
			this.getSectors
		);
	}

	private async getSectors(req: Request, res: Response) {
		const instance = req.session.instance;
		const wallets = await sectorsService.getSectors(instance);

		res.status(200).json({
			message: "Sectors retrieved successfully!",
			data: wallets
		});
	}
}

export default new SectorsController(Router());
