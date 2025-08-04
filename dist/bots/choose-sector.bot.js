"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const whatsapp_service_1 = __importDefault(require("../services/whatsapp.service"));
const sectors_service_1 = __importDefault(require("../services/sectors.service"));
const messages_distribution_service_1 = __importDefault(require("../services/messages-distribution.service"));
class ChooseSectorBot {
    running = [];
    getRunningStep(chatId) {
        const running = this.running.find((r) => r.chatId === chatId);
        if (!running) {
            return this.setRunningStep(chatId, 1);
        }
        return running.step;
    }
    setRunningStep(chatId, step) {
        const running = this.running.find((r) => r.chatId === chatId);
        if (running) {
            running.step = step;
        }
        else {
            this.running.push({ chatId, step });
        }
        return step;
    }
    removeRunningStep(chatId) {
        const index = this.running.findIndex((r) => r.chatId === chatId);
        if (index !== -1) {
            this.running.splice(index, 1);
        }
    }
    async processMessage(chat, contact, message) {
        console.log("111");
        const currentStep = this.getRunningStep(chat.id);
        const sectors = await sectors_service_1.default.getSectors(chat.instance);
        if (!sectors) {
            throw new Error(`No sectors found for instance ${chat.instance}`);
        }
        console.log("222", currentStep);
        const sectorsMessage = `Olá, tudo bem? Escolha um setor para continuar:\n${sectors.map((s, i) => `${i + 1} - ${s.name}`).join("\n")}` +
            "\nDigite o número do setor desejado!";
        switch (currentStep) {
            case 1:
                console.log("333");
                await whatsapp_service_1.default.sendBotMessage(message.from, {
                    chat,
                    text: sectorsMessage,
                    quotedId: message.id
                });
                this.setRunningStep(chat.id, 2);
                break;
            case 2:
                console.log("444");
                const chooseOption = message.body.trim().replace(/[^0-9]/g, "");
                const chooseSector = sectors.find((s) => s.id === Number(chooseOption));
                if (chooseSector) {
                    const answer = "Estamos te redirecionado para o setor escolhido.\nVocê será atendido em breve!";
                    await whatsapp_service_1.default.sendBotMessage(message.from, {
                        chat,
                        text: answer,
                        quotedId: message.id
                    });
                    await messages_distribution_service_1.default.transferChatSector(chooseSector, contact, chat);
                    this.removeRunningStep(chat.id);
                    break;
                }
                await whatsapp_service_1.default.sendBotMessage(message.from, {
                    chat,
                    text: "Opção inválida! Tente novamente.",
                    quotedId: message.id
                });
                break;
            default:
                break;
        }
    }
}
exports.default = new ChooseSectorBot();
