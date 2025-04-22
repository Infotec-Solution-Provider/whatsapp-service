import { Request, Response, Router } from "express";
import walletsService from "../services/wallets.service";

class WalletsController {
	constructor(public readonly router: Router) {
		this.router.post("/api/wallets", this.createWallet);
		this.router.delete("/api/wallets/:id", this.deleteWallet);
		this.router.put("/api/wallets/:id/name", this.updateWalletName);
		this.router.post("/api/wallets/:walletId/users", this.addUserToWallet);
		this.router.delete("/api/wallets/:walletId/users/:userId", this.removeUserFromWallet);
		this.router.get("/api/wallets", this.getWallets);
		this.router.get("/api/wallets/:id", this.findWalletById);
		this.router.get("/api/wallets/:id/users", this.getWalletUsers);
		this.router.get("/api/users/:userId/wallets", this.getUserWallets);
		this.router.get("/api/wallets/:walletId/users/:userId", this.findUserInWallet);
	}

	private handleError(res: Response, error: unknown, defaultMessage: string) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		res.status(500).json({
			message: defaultMessage,
			error: errorMessage
		});
	}

	private async createWallet(req: Request, res: Response) {
		const { instance, userId, name } = req.body;
		if (!instance || !userId || !name) {
			res.status(400).json({ message: "Missing required fields: instance, userId, name" });
			return;
		}

		try {
			const wallet = await walletsService.createWallet(instance, Number(userId), name);
			res.status(201).json({ message: "Wallet created successfully", data: wallet });
		} catch (error) {
			this.handleError(res, error, "Error creating wallet");
		}
	}

	private deleteWallet = async (req: Request, res: Response) => {
		const { id } = req.params;
		try {
			await walletsService.deleteWallet(Number(id));
			res.status(200).json({ message: "Wallet deleted successfully" });
		} catch (error) {
			this.handleError(res, error, "Error deleting wallet");
		}
	}

	private updateWalletName = async (req: Request, res: Response) => {
		const { id } = req.params;
		const { newName } = req.body;
		if (!newName) {
			res.status(400).json({ message: "Missing newName in request body" });
			return;
		}

		try {
			const wallet = await walletsService.updateWalletName(Number(id), newName);
			res.status(200).json({ message: "Wallet name updated", data: wallet });
		} catch (error) {
			this.handleError(res, error, "Error updating wallet name");
		}
	}

	private addUserToWallet = async (req: Request, res: Response) => {
		const { walletId } = req.params;
		const { userId } = req.body;
		if (!userId) {
			res.status(400).json({ message: "Missing userId in request body" });
			return;
		}

		try {
			const wallet = await walletsService.addUserToWallet(Number(walletId), Number(userId));
			res.status(200).json({ message: "User added to wallet", data: wallet });
		} catch (error) {
			this.handleError(res, error, "Error adding user to wallet");
		}
	}

	private removeUserFromWallet = async (req: Request, res: Response) => {
		const { walletId, userId } = req.params;
		try {
			const wallet = await walletsService.removeUserFromWallet(Number(walletId), Number(userId));
			res.status(200).json({ message: "User removed from wallet", data: wallet });
		} catch (error) {
			this.handleError(res, error, "Error removing user from wallet");
		}
	}

	private getWallets = async (_req: Request, res: Response) => {
		try {
			const wallets = await walletsService.getWallets();
			res.status(200).json({ data: wallets });
		} catch (error) {
			this.handleError(res, error, "Error fetching wallets");
		}
	}

	private findWalletById = async (req: Request, res: Response) => {
		const { id } = req.params;
		try {
			const wallet = await walletsService.findWalletById(Number(id));
			if (!wallet) {
				res.status(404).json({ message: "Wallet not found" });
				return;
			}
			res.status(200).json({ data: wallet });
		} catch (error) {
			this.handleError(res, error, "Error fetching wallet");
		}
	}

	private getWalletUsers = async (req: Request, res: Response) => {
		const { id } = req.params;
		try {
			const userIds = await walletsService.getWalletUsers(Number(id));
			res.status(200).json({ data: userIds });
		} catch (error) {
			this.handleError(res, error, "Error fetching wallet users");
		}
	}

	private getUserWallets = async (req: Request, res: Response) => {
		const { userId } = req.params;
		const { instance } = req.query;

		if (!instance) {
			res.status(400).json({ message: "Missing instance query parameter" });
			return;
		}

		try {
			const wallets = await walletsService.getUserWallets(
				instance as string,
				Number(userId)
			);
			res.status(200).json({ data: wallets });
		} catch (error) {
			this.handleError(res, error, "Error fetching user wallets");
		}
	}

	private findUserInWallet = async (req: Request, res: Response) => {
		const { walletId, userId } = req.params;
		try {
			const relation = await walletsService.findUserInWallet(
				Number(walletId),
				Number(userId)
			);

			if (!relation) {
				res.status(404).json({ message: "User not found in wallet" });
				return;
			}

			res.status(200).json({ data: relation });
		} catch (error) {
			this.handleError(res, error, "Error finding user in wallet");
		}
	}
}

export default new WalletsController(Router());