"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
        ctx.logger.log("O contato não é apenas administrador.");
        return {
            isFinal: false,
            stepId: this.nextStepId
        };
    }
}
exports.default = CheckOnlyAdminStep;
