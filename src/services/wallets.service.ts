import prismaService from "./prisma.service";

class WalletsService {
	public async getUserWallets(instance: string, userId: number) {
		return await prismaService.wppWallet.findMany({
			where: {
				instance,
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
