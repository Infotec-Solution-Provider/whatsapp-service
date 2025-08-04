"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const whatsapp_service_1 = __importDefault(require("../services/whatsapp.service"));
const sectors_service_1 = __importDefault(require("../services/sectors.service"));
const messages_distribution_service_1 = __importDefault(require("../services/messages-distribution.service"));
const instances_service_1 = __importDefault(require("../services/instances.service"));
const sdk_1 = require("@in.pulse-crm/sdk");
const socket_service_1 = __importDefault(require("../services/socket.service"));
const prisma_service_1 = __importDefault(require("../services/prisma.service"));
class ChooseSectorBot {
    running = [];
    runningOperadorOld = [];
    chatState = new Map();
    getRunningStep(chatId) {
        const running = this.running.find((r) => r.chatId === chatId);
        if (!running) {
            return this.setRunningStep(chatId, 1);
        }
        return running.step;
    }
    forceStep(chatId, step, operadorOldId) {
        this.setRunningStep(chatId, step);
        this.setOperadorOld(chatId, operadorOldId);
    }
    getOperadorOld(chatId) {
        const running = this.runningOperadorOld.find((r) => r.chatId === chatId);
        if (!running) {
            return this.setRunningStep(chatId, 1);
        }
        return running.operadorOldId;
    }
    setOperadorOld(chatId, operadorOldId) {
        const running = this.runningOperadorOld.find((r) => r.chatId === chatId);
        if (running) {
            running.operadorOldId = operadorOldId;
        }
        else {
            this.runningOperadorOld.push({ chatId, operadorOldId });
        }
        return operadorOldId;
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
        const currentStep = this.getRunningStep(chat.id);
        const sectors = await sectors_service_1.default.getSectors(chat.instance, {
            receiveChats: true
        });
        if (!sectors) {
            throw new Error(`No sectors found for instance ${chat.instance}`);
        }
        let chooseSectorMessage = `Escolha um setor para continuar:\n${sectors.map((s, i) => `${i + 1} - ${s.name}`).join("\n")}`;
        if (chat.instance === "nunes") {
            chooseSectorMessage =
                `Olá,\nEstamos felizes por você entrar em contato com a Metalúrgica Nunes, Usinagem de Precisão. ` +
                    `Escolha um setor para continuar:\n${sectors.map((s, i) => `${i + 1} - ${s.name}`).join("\n")}`;
        }
        switch (currentStep) {
            case 1:
                await whatsapp_service_1.default.sendBotMessage(message.from, {
                    chat,
                    text: chooseSectorMessage,
                    quotedId: message.id
                });
                this.setRunningStep(chat.id, 2);
                break;
            case 2:
                const chooseOption = Number(message.body.trim().replace(/[^0-9]/g, ""));
                const isValid = chooseOption > 0 && chooseOption <= sectors.length;
                const chooseSector = isValid && sectors[+chooseOption - 1];
                if (chooseSector) {
                    let setorId = sectors[+chooseOption - 1];
                    let query = `SELECT * FROM operadores WHERE SETOR = ${setorId?.id} order by NOME`;
                    let operadores = await instances_service_1.default.executeQuery(chat.instance, query, []);
                    if (setorId?.name === "Financeiro" &&
                        chat.instance === "nunes") {
                        operadores = operadores.filter((o) => o.NOME !== "Andréia");
                    }
                    if (setorId?.name === "Compras" &&
                        chat.instance === "nunes") {
                        operadores = operadores.filter((o) => o.NOME !== "Jorel");
                    }
                    const answer = `Escolha com quem deseja falar\n${operadores.map((s, i) => `${i + 1} - ${s.NOME}`).join("\n")}` +
                        `\n0 - Voltar à escolha de setor`;
                    await whatsapp_service_1.default.sendBotMessage(message.from, {
                        chat,
                        text: answer,
                        quotedId: message.id
                    });
                    this.chatState.set(String(chat.id), {
                        operadores,
                        setor: chooseSector
                    });
                    this.setRunningStep(chat.id, 3);
                    break;
                }
                await whatsapp_service_1.default.sendBotMessage(message.from, {
                    chat,
                    text: "Opção inválida! Tente novamente.",
                    quotedId: message.id
                });
                break;
            case 3:
                const chooseOptionOp = Number(message.body.trim().replace(/[^0-9]/g, ""));
                if (chooseOptionOp === 0) {
                    await whatsapp_service_1.default.sendBotMessage(message.from, {
                        chat,
                        text: "Tudo bem, voltando para a escolha de setor...",
                        quotedId: message.id
                    });
                    await whatsapp_service_1.default.sendBotMessage(message.from, {
                        chat,
                        text: chooseSectorMessage,
                        quotedId: message.id
                    });
                    this.setRunningStep(chat.id, 2);
                    break;
                }
                const state = this.chatState.get(String(chat.id));
                const operadores = state?.operadores || [];
                const sector = state?.setor;
                const isValids = chooseOptionOp > 0 && chooseOptionOp <= operadores.length;
                const chooseOp = isValids && operadores[+chooseOptionOp - 1];
                if (chooseOp) {
                    const answer = `Estamos te redirecionado para o atendente ${chooseOp.NOME}.\nVocê será atendido em breve!`;
                    await whatsapp_service_1.default.sendBotMessage(message.from, {
                        chat,
                        text: answer,
                        quotedId: message.id
                    });
                    const operatoranswer = `*${chooseOp.NOME}*: Olá, em que posso ajudar?`;
                    await whatsapp_service_1.default.sendBotMessage(message.from, {
                        chat,
                        text: operatoranswer,
                        quotedId: message.id
                    });
                    await messages_distribution_service_1.default.transferChatOperator(sector, chooseOp, contact, chat);
                    this.removeRunningStep(chat.id);
                    break;
                }
                await whatsapp_service_1.default.sendBotMessage(message.from, {
                    chat,
                    text: "Opção inválida! Tente novamente.",
                    quotedId: message.id
                });
                break;
            case 4:
                const option = Number(message.body.trim().replace(/[^0-9]/g, ""));
                switch (option) {
                    case 1:
                        await whatsapp_service_1.default.sendBotMessage(message.from, {
                            chat,
                            text: "Certo, retornando ao menu de setores...",
                            quotedId: message.id
                        });
                        await whatsapp_service_1.default.sendBotMessage(message.from, {
                            chat,
                            text: chooseSectorMessage,
                            quotedId: message.id
                        });
                        this.setRunningStep(chat.id, 2);
                        break;
                    case 2:
                        await whatsapp_service_1.default.sendBotMessage(message.from, {
                            chat,
                            text: "Atendimento encerrado. Caso precise de algo, estamos à disposição!",
                            quotedId: message.id
                        });
                        await prisma_service_1.default.wppChat.update({
                            where: { id: chat.id },
                            data: {
                                isFinished: true,
                                finishedAt: new Date(),
                                finishedBy: null
                            }
                        });
                        const event = sdk_1.SocketEventType.WppChatFinished;
                        let finishMsg = `Atendimento finalizado pelo cliente devido inatividade do operador.`;
                        await messages_distribution_service_1.default.addSystemMessage(chat, finishMsg);
                        await socket_service_1.default.emit(event, `${"nunes"}:chat:${chat.id}`, {
                            chatId: chat.id
                        });
                        this.removeRunningStep(chat.id);
                        break;
                    case 3:
                        await whatsapp_service_1.default.sendBotMessage(message.from, {
                            chat,
                            text: "Tudo bem! Vamos continuar aguardando o atendimento.",
                            quotedId: message.id
                        });
                        this.removeRunningStep(chat.id);
                        let user = this.getOperadorOld(chat.id);
                        await prisma_service_1.default.wppChat.update({
                            where: { id: chat.id },
                            data: { userId: user, botId: null }
                        });
                        break;
                    default:
                        await whatsapp_service_1.default.sendBotMessage(message.from, {
                            chat,
                            text: "Opção inválida! Responda apenas com o número da opção desejada.",
                            quotedId: message.id
                        });
                        break;
                }
                break;
            default:
                break;
        }
    }
}
exports.default = new ChooseSectorBot();
