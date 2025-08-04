"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const whatsapp_service_1 = __importDefault(require("../services/whatsapp.service"));
const messages_distribution_service_1 = __importDefault(require("../services/messages-distribution.service"));
const prisma_service_1 = __importDefault(require("../services/prisma.service"));
const OPERATORS = {
    aline: { name: "Aline", id: 13 },
    hellen: { name: "Hellen", id: 12 },
    nathalia: { name: "Nathalia", id: 4 }
};
class ChooseSellerBot {
    running = [];
    getOrCreate(contact) {
        let session = this.running.find((s) => s.contact === contact);
        if (!session) {
            session = { contact, step: 1 };
            this.running.push(session);
        }
        return session;
    }
    remove(contact) {
        this.running = this.running.filter((s) => s.contact !== contact);
    }
    async processMessage(chat, contact, message) {
        const session = this.getOrCreate(chat.id.toString());
        const msg = message.body.trim().toLowerCase();
        switch (session.step) {
            case 1: {
                const welcome = `Olá! 😊\n\nCom qual das nossas vendedoras você gostaria de falar?\n\nAline, Hellen ou Nathalia?\n\nCaso ainda não tenha sido atendido(a) por nenhuma delas, é só responder com: "Nova vendedora" que vamos te direcionar para o próximo atendimento disponível.\n\nFico no aguardo da sua escolha!`;
                await whatsapp_service_1.default.sendBotMessage(message.from, {
                    chat,
                    text: welcome,
                    quotedId: message.id
                });
                session.step = 2;
                break;
            }
            case 2: {
                if (msg === "nova vendedora") {
                    const sector = await prisma_service_1.default.wppSector.findUnique({
                        where: { id: chat.sectorId }
                    });
                    if (!sector) {
                        await whatsapp_service_1.default.sendBotMessage(message.from, {
                            chat,
                            text: "Setor não encontrado. Por favor, tente novamente mais tarde.",
                            quotedId: message.id
                        });
                        this.remove(chat.id.toString());
                        break;
                    }
                    const operatorKeys = Object.keys(OPERATORS);
                    const randomKey = operatorKeys[Math.floor(Math.random() * operatorKeys.length)];
                    const defaultOperator = OPERATORS[randomKey];
                    const fakeUser = { NOME: defaultOperator?.name, CODIGO: defaultOperator?.id };
                    await whatsapp_service_1.default.sendBotMessage(message.from, {
                        chat,
                        text: `Perfeito! Vamos direcionar você para o próximo atendimento disponível.`,
                        quotedId: message.id
                    });
                    await messages_distribution_service_1.default.transferChatOperator({
                        id: sector.id,
                        instance: sector.instance,
                        name: sector.name,
                        wppInstanceId: sector.wppInstanceId,
                        receiveChats: sector.receiveChats,
                        startChats: sector.startChats
                    }, fakeUser, contact, chat);
                    this.remove(chat.id.toString());
                    break;
                }
                const found = Object.keys(OPERATORS).find((key) => msg.includes(key));
                if (found) {
                    const op = OPERATORS[found];
                    const user = { NOME: op?.name, CODIGO: op?.id };
                    const sector = await prisma_service_1.default.wppSector.findUnique({
                        where: { id: chat.sectorId }
                    });
                    if (!sector) {
                        await whatsapp_service_1.default.sendBotMessage(message.from, {
                            chat,
                            text: "Setor não encontrado. Por favor, tente novamente mais tarde.",
                            quotedId: message.id
                        });
                        this.remove(chat.id.toString());
                        break;
                    }
                    await whatsapp_service_1.default.sendBotMessage(message.from, {
                        chat,
                        text: `Você escolheu falar com ${op?.name}.`,
                        quotedId: message.id
                    });
                    await whatsapp_service_1.default.sendBotMessage(message.from, {
                        chat,
                        text: `*${op?.name}*: Olá! Em que posso te ajudar?`,
                        quotedId: message.id
                    });
                    await messages_distribution_service_1.default.transferChatOperator({
                        id: sector.id,
                        instance: sector.instance,
                        name: sector.name,
                        wppInstanceId: sector.wppInstanceId,
                        receiveChats: sector.receiveChats,
                        startChats: sector.startChats
                    }, user, contact, chat);
                    this.remove(chat.id.toString());
                    break;
                }
                await whatsapp_service_1.default.sendBotMessage(message.from, {
                    chat,
                    text: `Por gentileza, escolha uma das vendedoras abaixo:\nAline, Hellen ou Nathalia?`,
                    quotedId: message.id
                });
                break;
            }
        }
    }
}
exports.default = new ChooseSellerBot();
