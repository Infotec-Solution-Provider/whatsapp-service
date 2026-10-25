import { Request, Response, Router } from "express";
import walletsService from "../services/wallets.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import { BadRequestError } from "@rgranatodutra/http-errors";

class WalletsController {
	constructor(public readonly router: Router) {
		this.router.get("/api/wallets", isAuthenticated, this.getUserWallets);
		this.router.get("/api/users/:userId/wallets", isAuthenticated, async (req, res) => {
			if (Object.keys(req.query).some(key => key !== "instance") || req.query["instance"] !== undefined && req.query["instance"] !== req.session.instance) throw new BadRequestError("Consulta inválida para esta empresa.");
			res.json({ data: await walletsService.getUserWallets(req.session, req.params["userId"]) });
		});
		this.router.get("/api/wallets/manage", isAuthenticated, async (req, res) => {
			if (Object.keys(req.query).some(key => key !== "after")) throw new BadRequestError("Consulta inválida.");
			res.json({ message: "Carteiras consultadas.", ...await walletsService.list(req.session, req.query["after"]) });
		});
		this.router.get("/api/wallets/:walletId", isAuthenticated, async (req, res) => res.json({ data: await walletsService.get(req.session, req.params["walletId"]) }));
		this.router.get("/api/wallets/:walletId/users", isAuthenticated, async (req, res) => res.json({ data: (await walletsService.get(req.session, req.params["walletId"])).userIds }));
		this.router.post("/api/wallets", isAuthenticated, async (req, res) => res.status(201).json({ data: await walletsService.create(req.session, req.body) }));
		this.router.put("/api/wallets/:walletId/name", isAuthenticated, async (req, res) => res.json({ data: await walletsService.rename(req.session, req.params["walletId"], req.body) }));
		this.router.delete("/api/wallets/:walletId", isAuthenticated, async (req, res) => res.json({ data: await walletsService.remove(req.session, req.params["walletId"], req.body) }));
		this.router.post("/api/wallets/:walletId/users", isAuthenticated, async (req, res) => res.json({ data: await walletsService.addUser(req.session, req.params["walletId"], req.body) }));
		this.router.delete("/api/wallets/:walletId/users/:userId", isAuthenticated, async (req, res) => res.json({ data: await walletsService.removeUser(req.session, req.params["walletId"], req.params["userId"]) }));
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
