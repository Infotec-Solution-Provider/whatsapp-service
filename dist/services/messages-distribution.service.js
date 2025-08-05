"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const message_flow_factory_1 = __importDefault(require("../message-flow/message-flow.factory"));
const prisma_service_1 = __importDefault(require("./prisma.service"));
const contacts_service_1 = __importDefault(require("./contacts.service"));
const utils_1 = require("@in.pulse-crm/utils");
const processing_logger_1 = __importDefault(require("../utils/processing-logger"));
const socket_service_1 = __importDefault(require("./socket.service"));
const sdk_1 = require("@in.pulse-crm/sdk");
const chats_service_1 = __importDefault(require("./chats.service"));
const messages_service_1 = __importDefault(require("./messages.service"));
const whatsapp_service_1 = __importDefault(require("./whatsapp.service"));
const choose_sector_bot_1 = __importDefault(require("../bots/choose-sector.bot"));
const seller_vollo_bot_1 = __importDefault(require("../bots/seller-vollo.bot"));
class MessagesDistributionService {
    flows = new Map();
    async getFlow(instance, sectorId) {
        const flowKey = `${instance}:${sectorId}`;
        const flow = this.flows.get(flowKey);
        if (!flow) {
            const newFlow = await message_flow_factory_1.default.createMessageFlow(instance, sectorId);
            this.flows.set(flowKey, newFlow);
            return newFlow;
        }
        return flow;
    }
    async getSectors(clientId) {
        const sectors = await prisma_service_1.default.wppSector.findMany({
            where: {
                wppInstanceId: clientId,
                receiveChats: true
            }
        });
        if (!sectors || sectors.length === 0) {
            throw new Error("Setor não encontrado para esta instância.");
        }
        return sectors;
    }
    async processMessage(instance, clientId, msg) {
        const logger = new processing_logger_1.default(instance, "message-distribution", `WppMessage-${msg.id}`, msg);
        try {
            logger.log("Buscando contato para a mensagem.");
            const contact = await contacts_service_1.default.getOrCreateContact(instance, utils_1.Formatter.phone(msg.from), msg.from);
            logger.log("Contato encontrado!", contact);
            logger.log("Buscando chat para o contato.");
            const currChat = await chats_service_1.default.getChatForContact(clientId, contact);
            if (currChat) {
                logger.log("Chat anterior encontrado para o contato.", currChat);
                await this.insertAndNotify(logger, currChat, msg);
                if (currChat.botId === 1) {
                    if (currChat.instance === "vollo") {
                        await seller_vollo_bot_1.default.processMessage(currChat, contact, msg);
                    }
                    else {
                        await choose_sector_bot_1.default.processMessage(currChat, contact, msg);
                    }
                }
                return;
            }
            let newChat = null;
            logger.log("Nenhum chat encontrado para o contato.");
            const sectors = await this.getSectors(clientId);
            if (sectors.length > 1) {
                logger.log("Mais de um setor encontrado, iniciando o fluxo de escolha de setor.");
                newChat = await prisma_service_1.default.wppChat.create({
                    data: {
                        instance,
                        type: "RECEPTIVE",
                        contactId: contact.id,
                        sectorId: sectors[0].id,
                        startedAt: new Date(),
                        botId: 1
                    }
                });
            }
            else {
                logger.log("Um setor encontrado, iniciando o fluxo de atendimento.");
                const flow = await this.getFlow(instance, sectors[0].id);
                const data = await flow.getChatPayload(logger, contact);
                newChat = await prisma_service_1.default.wppChat.create({
                    data: {
                        ...data,
                        botId: instance === "vollo" ? 1 : null,
                        userId: null
                    }
                });
            }
            if (!newChat) {
                throw new Error("Nenhum chat foi criado.");
            }
            if (newChat.botId === 1) {
                if (newChat.instance === "vollo") {
                    await seller_vollo_bot_1.default.processMessage(newChat, contact, msg);
                }
                else {
                    await choose_sector_bot_1.default.processMessage(newChat, contact, msg);
                }
            }
            logger.log("Novo chat encontrado!", newChat);
            logger.log("Buscando foto de perfil do cliente.");
            const avatarUrl = await whatsapp_service_1.default.getProfilePictureUrl(instance, msg.from);
            if (avatarUrl) {
                await prisma_service_1.default.wppChat.update({
                    data: { avatarUrl },
                    where: { id: newChat.id }
                });
            }
            await this.addSystemMessage(newChat, "Atendimento iniciado pelo cliente!", true);
            logger.log("Chat criado com sucesso!", newChat);
            await this.insertAndNotify(logger, newChat, msg, true);
        }
        catch (err) {
            console.error(err);
            logger.log(`Erro ao processar mensagem!`);
            logger.failed(err);
        }
    }
    async transferChatSector(sector, contact, chat) {
        const logger = new processing_logger_1.default(sector.instance, "transfer-chat-sector", `WppChat-${chat.id}_${Date.now()}`, { sector, contact, chat });
        try {
            const flow = await this.getFlow(sector.instance, sector.id);
            const data = await flow.getChatPayload(logger, contact);
            const updatedChat = await prisma_service_1.default.wppChat.update({
                where: { id: chat.id },
                data: { ...data, botId: null }
            });
            await this.addSystemMessage(updatedChat, `Transferido para o setor ${sector.name}!`);
            await this.notifyChatStarted(logger, updatedChat);
            logger.success(updatedChat);
        }
        catch (err) {
            console.error(err);
            logger.log(`Erro ao processar mensagem!`);
            logger.failed(err);
        }
    }
    async transferChatOperator(sector, operador, contact, chat) {
        const logger = new processing_logger_1.default(sector.instance, "transfer-chat-operator", `WppChat-${chat.id}_${Date.now()}`, { sector, contact, chat });
        try {
            const flow = await this.getFlow(sector.instance, sector.id);
            const data = await flow.getChatPayload(logger, contact);
            const updatedChat = await prisma_service_1.default.wppChat.update({
                where: { id: chat.id },
                data: { ...data, userId: operador.CODIGO, botId: null }
            });
            await this.addSystemMessage(updatedChat, `Transferido para o setor ${sector.name}!`);
            await this.notifyChatStarted(logger, updatedChat);
            logger.success(updatedChat);
        }
        catch (err) {
            console.error(err);
            logger.log(`Erro ao processar mensagem!`);
            logger.failed(err);
        }
    }
    async notifyChatStarted(process, chat) {
        try {
            const data = { chatId: chat.id };
            const monitorRoom = `${chat.instance}:${chat.sectorId}:monitor`;
            await socket_service_1.default.emit(sdk_1.SocketEventType.WppChatStarted, monitorRoom, data);
            process.log(`Chat enviado para o socket: /${monitorRoom}/ room!`);
            if (chat.walletId) {
                const walletRoom = `${chat.instance}:wallet:${chat.walletId}`;
                await socket_service_1.default.emit(sdk_1.SocketEventType.WppChatStarted, walletRoom, data);
                process.log(`Chat enviado para o socket: /${walletRoom}/ room!`);
            }
            if (chat.userId === -1) {
                const adminRoom = `${chat.instance}:${chat.sectorId}:admin`;
                await socket_service_1.default.emit(sdk_1.SocketEventType.WppChatStarted, adminRoom, data);
                process.log(`Chat enviado para o socket: /${adminRoom}/ room!`);
            }
            if (chat.userId) {
                const userRoom = `${chat.instance}:user:${chat.userId}`;
                await socket_service_1.default.emit(sdk_1.SocketEventType.WppChatStarted, userRoom, data);
                process.log(`Chat enviado para o socket: /${userRoom}/ room!`);
            }
        }
        catch (err) {
            const msg = (0, utils_1.sanitizeErrorMessage)(err);
            process.log(`Erro ao enviar o chat para o socket: ${msg}`);
            throw err;
        }
    }
    async notifyMessage(process, message) {
        try {
            process?.log("Transmitindo mensagem via socket.");
            const instance = message.instance;
            if (message.chatId === null) {
                process?.log("Mensagem não possui chatId.");
                return;
            }
            const room = `${instance}:chat:${message.chatId}`;
            const data = { message };
            await socket_service_1.default.emit(sdk_1.SocketEventType.WppMessage, room, data);
            process?.log(`Mensagem transmitida para a sala: /${room}/ room!`);
        }
        catch (err) {
            const msg = (0, utils_1.sanitizeErrorMessage)(err);
            process?.log(`Falha ao transmitir mensagem: ${msg}`);
            throw err;
        }
    }
    async insertMessageOnChat(logger, message, chat) {
        try {
            const insertedMessage = await prisma_service_1.default.wppMessage.update({
                where: {
                    id: message.id
                },
                data: {
                    contactId: chat.contactId,
                    chatId: chat.id,
                    status: "RECEIVED"
                }
            });
            logger.log("Mensagem inserida no chat.", insertedMessage);
            return insertedMessage;
        }
        catch (err) {
            const msg = (0, utils_1.sanitizeErrorMessage)(err);
            logger.log(`Erro ao inserir a mensagem no chat: ${msg}`);
            throw err;
        }
    }
    async insertAndNotify(logger, chat, msg, isChatNew = false) {
        const insertedMsg = await this.insertMessageOnChat(logger, msg, chat);
        if (isChatNew) {
            await this.notifyChatStarted(logger, chat);
        }
        await this.notifyMessage(logger, insertedMsg);
        logger.success(insertedMsg);
    }
    async processMessageStatus(type, id, status) {
        try {
            const search = type === "wwebjs" ? { wwebjsId: id } : { wabaId: id };
            if (!("wwebjsId" in search) && !("wabaId" in search)) {
                return;
            }
            const message = await prisma_service_1.default.wppMessage.update({
                where: search,
                data: {
                    status
                }
            });
            if (message.chatId === null) {
                return;
            }
            const chatRoom = `${message.instance}:chat:${message.chatId}`;
            socket_service_1.default.emit(sdk_1.SocketEventType.WppMessageStatus, chatRoom, {
                messageId: message.id,
                contactId: message.contactId,
                status
            });
        }
        catch (err) {
            const msg = (0, utils_1.sanitizeErrorMessage)(err);
            console.error(`Erro ao processar status da mensagem: ${msg}`);
        }
    }
    async addSystemMessage(chat, text, notify = true) {
        const message = await messages_service_1.default.insertMessage({
            body: text,
            from: "system",
            to: "system",
            instance: chat.instance,
            status: "RECEIVED",
            timestamp: Date.now().toString(),
            type: "chat",
            chatId: chat.id,
            contactId: chat.contactId
        });
        if (notify) {
            const chatRoom = `${chat.instance}:chat:${chat.id}`;
            socket_service_1.default.emit(sdk_1.SocketEventType.WppMessage, chatRoom, {
                message
            });
        }
    }
}
exports.default = new MessagesDistributionService();
