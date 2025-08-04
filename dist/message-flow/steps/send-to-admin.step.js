"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
        const chatData = {
            instance: this.instance,
            type: "RECEPTIVE",
            userId: -1,
            sectorId: this.sectorId,
            contactId: ctx.contact.id
        };
        ctx.logger.log("Chat criado.", chatData);
        return {
            isFinal: true,
            chatData
        };
    }
}
exports.default = SendToAdminStep;
