import { Request, Response, Router } from "express";
import walletsService from "../services/wallets.service";

class WalletsController {
	constructor(public readonly router: Router) {
		this.router.get("/api/wallets", this.getUserWallets);
	}

	private async getUserWallets(req: Request, res: Response) {
		const userId = req.query["userId"] as string;
		const instance = req.query["instance"] as string;

		if (!userId || !instance) {
			res.status(400).json({
				message: "Query params 'userId' and 'instance' are required"
			});
			return;
		}

		const wallets = await walletsService.getUserWallets(instance, Number(userId));

		res.status(200).json({
			message: "Wallets retrieved successfully!",
			data: wallets
		});
	}
}

export default new WalletsController(Router());
