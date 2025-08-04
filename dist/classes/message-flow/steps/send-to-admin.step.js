"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = __importDefault(require("../../../services/prisma.service"));
class SendToAdminStep {
    instance;
    sectorId;
    id;
    constructor({ instance, stepId, sectorId }) {
        this.id = stepId;
        this.instance = instance;
        this.sectorId = sectorId;
    }
    async run(ctx) {
        ctx.logger.log("Enviando mensagem para o administrador...");
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
}
exports.default = SendToAdminStep;
