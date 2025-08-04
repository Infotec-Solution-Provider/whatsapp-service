"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = __importDefault(require("../../../services/prisma.service"));
class CheckOnlyAdminStep {
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
        ctx.logger.log("Verificando se o contato é apenas administrador...");
        if (ctx.contact.isOnlyAdmin) {
            ctx.logger.log("O contato é apenas administrador.");
            const chat = await prisma_service_1.default.wppChat.create({
                data: {
                    instance: this.instance,
                    type: "RECEPTIVE",
                    userId: -1,
                    sectorId: this.sectorId,
                    contactId: ctx.contact.id
                }
            });
            ctx.logger.log("Chat criado.", chat);
            return {
                isFinal: true,
                chat
            };
        }
        ctx.logger.log("O contato não é apenas administrador.");
        return {
            isFinal: false,
            stepId: this.nextStepId
        };
    }
}
exports.default = CheckOnlyAdminStep;
