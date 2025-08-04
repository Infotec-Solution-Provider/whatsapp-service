"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const instances_service_1 = __importDefault(require("../../../services/instances.service"));
const prisma_service_1 = __importDefault(require("../../../services/prisma.service"));
const instances_service_2 = __importDefault(require("../../../services/instances.service"));
const CHECK_LOALTY_QUERY = `SELECT * FROM campanhas_clientes cc
            WHERE cc.CLIENTE = ?
            ORDER BY CODIGO DESC LIMIT 1;`;
class CheckLoaltyStep {
    instance;
    sectorId;
    nextStepId;
    id;
    constructor({ instance, sectorId, stepId, nextStepId }) {
        this.instance = instance;
        this.sectorId = sectorId;
        this.nextStepId = nextStepId;
        this.id = stepId;
    }
    async run(ctx) {
        ctx.logger.log("Iniciando etapa de checagem de fidelização...");
        if (!ctx.contact.customerId) {
            return this.nextStep(ctx, "O contato não possui um ID de cliente.");
        }
        const customerSchedule = await this.fetchCustomerSchedule(ctx);
        if (!customerSchedule) {
            return this.nextStep(ctx, "Agendamento do cliente não encontrado.");
        }
        if (customerSchedule.OPERADOR === 0) {
            const msg = "O agendamento do cliente não possui um operador.";
            return this.nextStep(ctx, msg);
        }
        const isSameSector = await this.isUserInSameSector(this.instance, customerSchedule.OPERADOR);
        if (!isSameSector) {
            return this.nextStep(ctx, "O usuário não está no mesmo setor.");
        }
        const generatedChat = await this.createChat(ctx, customerSchedule.OPERADOR);
        ctx.logger.log("Chat criado com sucesso.", generatedChat);
        return { chat: generatedChat, isFinal: true };
    }
    async fetchCustomerSchedule(ctx) {
        ctx.logger.log("Buscando agendamento do cliente...");
        const result = await instances_service_1.default.executeQuery(this.instance, CHECK_LOALTY_QUERY, [ctx.contact.customerId]);
        return result[0] || null;
    }
    async isUserInSameSector(instance, userId) {
        const users = await instances_service_2.default.executeQuery(instance, "SELECT * FROM users WHERE id = ?", [userId]);
        return users.length > 0 && users[0].SETOR === this.sectorId;
    }
    async createChat(ctx, userId) {
        return prisma_service_1.default.wppChat.create({
            data: {
                instance: this.instance,
                type: "RECEPTIVE",
                userId: userId,
                contactId: ctx.contact.id,
                sectorId: this.sectorId
            }
        });
    }
    nextStep(ctx, logMessage) {
        ctx.logger.log(logMessage);
        return { isFinal: false, stepId: this.nextStepId };
    }
}
exports.default = CheckLoaltyStep;
