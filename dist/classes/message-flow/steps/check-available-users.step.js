"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const auth_service_1 = __importDefault(require("../../../services/auth.service"));
const prisma_service_1 = __importDefault(require("../../../services/prisma.service"));
class CheckAvailableUsersStep {
    instance;
    sectorId;
    nextStepId;
    id;
    constructor({ instance, sectorId, stepId, nextStepId }) {
        this.instance = instance;
        this.sectorId = sectorId;
        this.id = stepId;
        this.nextStepId = nextStepId;
    }
    async getUserChatsCount(sessions) {
        const userIds = sessions.map((session) => session.data.userId);
        const usersChats = await prisma_service_1.default.wppChat.groupBy({
            by: ["userId"],
            where: {
                userId: { in: userIds },
                isFinished: false,
                instance: this.instance
            },
            _count: { id: true },
            orderBy: { _count: { id: "asc" } }
        });
        return sessions
            .map((session) => {
            const userId = session.data.userId;
            const chats = usersChats.find((uc) => uc.userId === userId)?._count.id ||
                0;
            return { userId, chats };
        })
            .sort((a, b) => a.chats - b.chats);
    }
    async assignChatToUser(ctx, userId) {
        return prisma_service_1.default.wppChat.create({
            data: {
                instance: this.instance,
                userId,
                sectorId: this.sectorId,
                type: "RECEPTIVE",
                contactId: ctx.contact.id,
            }
        });
    }
    async getSectorOnlineSessions() {
        const sessions = await auth_service_1.default.getOnlineSessions(this.instance);
        return sessions.filter((s) => s.data.sectorId === this.sectorId);
    }
    async run(ctx) {
        ctx.logger.log("Verificando usuários disponíveis...");
        const sessions = await this.getSectorOnlineSessions();
        ctx.logger.log(`Encontradas ${sessions.length} sessões online`);
        if (sessions.length === 0) {
            ctx.logger.log("Nenhum usuário disponível encontrado.");
            return { isFinal: false, stepId: this.nextStepId };
        }
        const usersChats = await this.getUserChatsCount(sessions);
        if (usersChats.length === 0) {
            ctx.logger.log("Nenhum usuário disponível encontrado.");
            return { isFinal: false, stepId: this.nextStepId };
        }
        const { userId } = usersChats[0];
        const chat = await this.assignChatToUser(ctx, userId);
        ctx.logger.log(`Usuário ${userId} será atribuído ao chat.`, chat);
        return { isFinal: true, chat };
    }
}
exports.default = CheckAvailableUsersStep;
