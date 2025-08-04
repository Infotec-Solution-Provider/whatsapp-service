"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = __importDefault(require("./prisma.service"));
class WalletsService {
    async getUserWallets(instance, userId) {
        return await prisma_service_1.default.wppWallet.findMany({
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
exports.default = new WalletsService();
