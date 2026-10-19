import { Request, Response, Router } from "express";
import sectorsService from "../services/sectors.service";
import publicBiRateLimit from "../middlewares/public-bi-rate-limit.middleware";
import publicBiAuthenticated from "../middlewares/public-bi-auth.middleware";

class SectorsController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/sectors",
			publicBiAuthenticated,
			publicBiRateLimit,
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
