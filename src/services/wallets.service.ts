import prismaService from "./prisma.service";
import type { SessionData } from "../sdk-local";
import { UnauthorizedError } from "@rgranatodutra/http-errors";
import positiveResourceId from "../utils/positive-resource-id";

class WalletsService {
	public async getUserWallets(session: SessionData, rawUserId?: unknown) {
		const userId = positiveResourceId(rawUserId ?? session.userId);
		if (session.role !== "ADMIN" && userId !== session.userId) {
			throw new UnauthorizedError("Você só pode consultar suas próprias carteiras.");
		}
		return await prismaService.wppWallet.findMany({
			where: {
				instance: session.instance,
				WppWalletUser: {
					some: {
						userId,
					}
				}
			}
		});
	}
}

export default new WalletsService();
