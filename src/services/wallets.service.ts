import prismaService from "./prisma.service";

class WalletsService {
	public async createWallet(instance: string, name: string) {
		return await prismaService.wppWallet.create({
			data: {
				instance: instance,
				name: name,
			}
		})
	}

	public async deleteWallet(walletId: number) {
		await prismaService.wppWalletUser.deleteMany({
			where: { walletId: walletId }
		})
		return await prismaService.wppWallet.delete({
			where: { id: walletId }
		})
	}

	public async updateWalletName(id: number, newName: string) {
		return await prismaService.wppWallet.update({
			where: { id: id },
			data: { name: newName }
		})
	}

	public async addUserToWallet(walletId: number, userId: number) {
		await prismaService.wppWalletUser.upsert({
			where: { walletId_userId: { walletId, userId } },
			create: { walletId, userId },
			update: {}
		});
		return this.getWalletById(walletId);
	}

	public async removeUserFromWallet(walletId: number, userId: number) {
		await prismaService.wppWalletUser.delete({
			where: {
				walletId_userId: {
					walletId,
					userId
				}
			}
		});
		return this.getWalletById(walletId)
	}

	public async getWallets() {
		const wallets = await prismaService.wppWallet.findMany({
			include: {
				WppWalletUser: {
					select: { userId: true }
				}
			}
		});
		return wallets.map(wallet => ({
			id: wallet.id,
			instance: wallet.instance,
			name: wallet.name,
			userIds: wallet.WppWalletUser.map(relation => relation.userId)
		}));
	}

	public async getWalletById(walletId: number) {
		const wallet = await prismaService.wppWallet.findUnique({
			where: { id: walletId },
			include: {
				WppWalletUser: {
					select: { userId: true },
				},
			},
		});

		if (!wallet) return null;

		return {
			id: wallet.id,
			instance: wallet.instance,
			name: wallet.name,
			userIds: wallet.WppWalletUser.map((rel) => rel.userId) || [],
		};
	}

	public async getWalletUsers(walletId: number) {
		const wallet = await prismaService.wppWallet.findUnique({
			where: { id: walletId },
			include: {
				WppWalletUser: {
					select: { userId: true }
				}
			}
		});
		if (!wallet) throw new Error('Carteira não encontrada');
		return wallet.WppWalletUser.map(relation => relation.userId);
	}

	public async getUserInWallet(walletId: number, userId: number) {
		return await prismaService.wppWalletUser.findUnique({
			where: {
				walletId_userId: {
					walletId,
					userId,
				},
			},
		});
	}

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
