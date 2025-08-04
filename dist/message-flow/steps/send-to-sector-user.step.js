"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const instances_service_1 = __importDefault(require("../../services/instances.service"));
class SendToSectorUserStep {
    instance;
    sectorId;
    id;
    constructor({ instance, stepId, sectorId }) {
        this.id = stepId;
        this.instance = instance;
        this.sectorId = sectorId;
    }
    async run(ctx) {
        ctx.logger.log("Enviando mensagem para um usuário do setor...");
        const users = await instances_service_1.default.executeQuery(this.instance, "SELECT * FROM operadores WHERE SETOR = ?", [this.sectorId]);
        const findAdmin = users.find((user) => user.NIVEL === "ADMIN");
        const findUser = users[0];
        const chatData = {
            instance: this.instance,
            type: "RECEPTIVE",
            userId: findAdmin?.CODIGO || findUser?.CODIGO || -1,
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
exports.default = SendToSectorUserStep;
