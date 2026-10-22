import { Request, Response, Router } from "express";
import walletsService from "../services/wallets.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import { BadRequestError } from "@rgranatodutra/http-errors";

class WalletsController {
	constructor(public readonly router: Router) {
		this.router.get("/api/wallets", isAuthenticated, this.getUserWallets);
	}

	private async getUserWallets(req: Request, res: Response) {
		if (req.query["instance"] !== undefined && req.query["instance"] !== req.session.instance) {
			throw new BadRequestError("A empresa informada difere da sessão.");
		}
		const wallets = await walletsService.getUserWallets(req.session, req.query["userId"]);

		res.status(200).json({
			message: "Wallets retrieved successfully!",
			data: wallets
		});
	}
}

export default new WalletsController(Router());
