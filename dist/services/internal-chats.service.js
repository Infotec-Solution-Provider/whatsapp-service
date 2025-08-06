"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const sdk_1 = require("@in.pulse-crm/sdk");
const socket_service_1 = __importDefault(require("./socket.service"));
const processing_logger_1 = __importDefault(require("../utils/processing-logger"));
const files_service_1 = __importDefault(require("./files.service"));
const utils_1 = require("@in.pulse-crm/utils");
const http_errors_1 = require("@rgranatodutra/http-errors");
const prisma_service_1 = __importDefault(require("./prisma.service"));
const whatsapp_service_1 = __importStar(require("./whatsapp.service"));
const wwebjs_whatsapp_client_1 = __importDefault(require("../whatsapp-client/wwebjs-whatsapp-client"));
const opus_audio_converter_1 = __importDefault(require("../utils/opus-audio-converter"));
class InternalChatsService {
    async createInternalChat(session, participantIds, isGroup = false, groupName = null, groupId = null, groupImage = null) {
        const uniqueIds = new Set(participantIds);
        let fileId = null;
        if (groupImage) {
            const fileData = await files_service_1.default.uploadFile({
                instance: session.instance,
                fileName: groupImage.originalname,
                buffer: groupImage.buffer,
                mimeType: groupImage.mimetype,
                dirType: sdk_1.FileDirType.PUBLIC
            });
            fileId = fileData.id;
        }
        const internalChat = await prisma_service_1.default.internalChat.create({
            data: {
                isGroup,
                groupName,
                wppGroupId: groupId,
                creatorId: session.userId,
                instance: session.instance,
                groupImageFileId: fileId
            }
        });
        await prisma_service_1.default.internalChatMember.createMany({
            data: Array.from(uniqueIds).map((id) => ({
                userId: id,
                internalChatId: internalChat.id,
                joinedAt: new Date()
            }))
        });
        const result = await prisma_service_1.default.internalChat.findUnique({
            where: { id: internalChat.id },
            include: {
                messages: true,
                participants: true
            }
        });
        for (const id of uniqueIds) {
            const room = `${session.instance}:user:${id}`;
            await socket_service_1.default.emit(sdk_1.SocketEventType.InternalChatStarted, room, {
                chat: result
            });
        }
        return result;
    }
    async updateInternalGroup(groupId, data) {
        const currentParticipants = await prisma_service_1.default.internalChatMember.findMany({
            where: {
                internalChatId: groupId
            }
        });
        const idsToAdd = data.participants.filter((p) => !currentParticipants.some((c) => c.userId === p));
        const idsToRemove = currentParticipants.filter((p) => !data.participants.includes(p.userId));
        const group = await prisma_service_1.default.internalChat.update({
            where: { id: groupId },
            data: {
                groupName: data.name,
                wppGroupId: data.wppGroupId,
                participants: {
                    createMany: {
                        data: idsToAdd.map((id) => ({
                            userId: id,
                            joinedAt: new Date()
                        }))
                    },
                    deleteMany: {
                        internalChatId: groupId,
                        userId: {
                            in: idsToRemove.map((p) => p.userId)
                        }
                    }
                }
            },
            include: { participants: true, messages: true }
        });
        for (const id of idsToAdd) {
            const room = `${group.instance}:user:${id}`;
            await socket_service_1.default.emit(sdk_1.SocketEventType.InternalChatStarted, room, {
                chat: group
            });
        }
        for (const id of idsToRemove) {
            const room = `${group.instance}:user:${id.userId}`;
            await socket_service_1.default.emit(sdk_1.SocketEventType.InternalChatFinished, room, {
                chatId: groupId
            });
        }
        return group;
    }
    async updateGroupImage(session, groupId, file) {
        const fileData = await files_service_1.default.uploadFile({
            instance: session.instance,
            fileName: file.originalname,
            buffer: file.buffer,
            mimeType: file.mimetype,
            dirType: sdk_1.FileDirType.PUBLIC
        });
        return await prisma_service_1.default.internalChat.update({
            where: { id: groupId },
            data: {
                groupImageFileId: fileData.id
            }
        });
    }
    async deleteInternalChat(id) {
        const chat = await prisma_service_1.default.internalChat.findUnique({
            where: { id }
        });
        if (!chat) {
            throw new http_errors_1.BadRequestError("Chat not found");
        }
        await prisma_service_1.default.internalChatMember.deleteMany({
            where: {
                internalChatId: id
            }
        });
        await prisma_service_1.default.internalMessage.deleteMany({
            where: {
                internalChatId: id
            }
        });
        await prisma_service_1.default.internalChat.delete({
            where: { id }
        });
        const room = `${chat.instance}:internal-chat:${id}`;
        await socket_service_1.default.emit(sdk_1.SocketEventType.InternalChatFinished, room, {
            chatId: id
        });
    }
    async getInternalChatsBySession(session) {
        const result = await prisma_service_1.default.internalChat.findMany({
            where: {
                instance: session.instance,
                participants: {
                    some: { userId: session.userId }
                }
            },
            include: {
                messages: true,
                participants: true
            }
        });
        const chats = [];
        const messages = [];
        result.forEach((c) => {
            const { messages: msgs, ...chat } = c;
            messages.push(...msgs);
            chats.push(chat);
        });
        return { chats, messages };
    }
    async getInternalChatsMonitor(session) {
        const isTI = session.sectorId === 3 || session.instance !== "nunes";
        const result = await prisma_service_1.default.internalChat.findMany({
            where: {
                isFinished: false,
                instance: session.instance,
                ...(isTI ? {} : { sectorId: session.sectorId })
            },
            include: {
                messages: true,
                participants: true
            }
        });
        const chats = [];
        const messages = [];
        result.forEach((c) => {
            const { messages: msgs, ...chat } = c;
            messages.push(...msgs);
            chats.push(chat);
        });
        return { chats, messages };
    }
    async getInternalGroups(session) {
        const result = await prisma_service_1.default.internalChat.findMany({
            where: {
                instance: session.instance,
                isGroup: true,
                isFinished: false
            },
            include: {
                participants: true,
                messages: true
            },
            orderBy: {
                startedAt: "desc"
            }
        });
        return result;
    }
    async getInternalChats(filters) {
        const whereClause = {};
        if (filters.userId) {
            whereClause.participants = {
                some: {
                    userId: +filters.userId
                }
            };
        }
        if (filters.isFinished) {
            whereClause.isFinished =
                filters.isFinished === "true" ? true : false;
        }
        const chats = await prisma_service_1.default.internalChat.findMany({
            include: {
                messages: true
            },
            where: whereClause
        });
        return chats;
    }
    async sendMessage(session, data) {
        const { file, ...logData } = data;
        const process = new processing_logger_1.default(session.instance, "internal-message", `${data.chatId}-${Date.now()}`, logData);
        process.log("Iniciando o envio da mensagem interna.");
        try {
            let mentionsText = "";
            if (data.mentions?.length) {
                let mentions = data.mentions;
                if (typeof mentions === "string") {
                    try {
                        mentions = JSON.parse(mentions);
                    }
                    catch (err) {
                        throw new http_errors_1.BadRequestError("mentions não é um JSON válido");
                    }
                }
                if (!Array.isArray(mentions)) {
                    throw new http_errors_1.BadRequestError("mentions precisa ser um array");
                }

                mentions
                    .map(user => {
                    const phone = user.phone?.replace(/\D/g, "");
                    if (!phone) {
                        process.log("Telefone inválido em menção:", user);
                        return null;
                    }
                    return `${phone}@c.us`;
                })
                    .filter((id) => id !== null);
                mentionsText = mentions
                    .map(user => `@${user.name || user.phone}`)
                    .join(" ");
            }
            const texto = data.text?.trim() ?? "";
            const usarMentionsText = !!mentionsText && /@\s*$/.test(texto);
            let message = {
                instance: session.instance,
                status: "RECEIVED",
                timestamp: Date.now().toString(),
                from: `user:${session.userId}`,
                type: "chat",
                body: usarMentionsText
                    ? texto.replace(/@\s*$/, mentionsText) : data.text,
                quotedId: data.quotedId ? Number(data.quotedId) : null,
                chat: {
                    connect: {
                        id: +data.chatId
                    }
                }
            };
            if ("fileId" in data) {
                message.fileId = +data.fileId;
            }
            if ("file" in data && !!data.file) {
                const buffer = data.sendAsAudio
                    ? await opus_audio_converter_1.default.convert(data.file.buffer)
                    : data.file.buffer;
                if (data.sendAsAudio) {
                    process.log("Mensagem convertida com sucesso.");
                }
                const file = await files_service_1.default.uploadFile({
                    instance: session.instance,
                    fileName: data.file.originalname,
                    buffer,
                    mimeType: data.file.mimetype,
                    dirType: sdk_1.FileDirType.PUBLIC
                });
                message.fileId = file.id;
                message.fileName = file.name;
                message.fileType = file.mime_type;
                message.fileSize = String(file.size);
                message.type = (0, whatsapp_service_1.getMessageType)(file.mime_type, !!data.sendAsAudio, !!data.sendAsDocument);
            }
            const savedMsg = await prisma_service_1.default.internalMessage.create({
                data: message
            });
            process.log("Mensagem salva no banco de dados.", savedMsg);
            if (data.mentions?.length) {
                const mentionsParsed = typeof data.mentions === "string" ? JSON.parse(data.mentions) : data.mentions || [];
                const mentionData = mentionsParsed.map((mention) => ({
                    userId: typeof mention === "object" ? mention.userId ?? mention.id : mention,
                    messageId: savedMsg.id,
                }));
                if (mentionData.length > 0) {
                    await prisma_service_1.default.internalMention.createMany({ data: mentionData });
                }
            }
            const room = `${session.instance}:internal-chat:${data.chatId}`;
            await socket_service_1.default.emit(sdk_1.SocketEventType.InternalMessage, room, {
                message: savedMsg
            });
            process.success("Mensagem enviada com sucesso.");
            const chat = await prisma_service_1.default.internalChat.findUnique({
                where: { id: +data.chatId }
            });
            if (chat?.wppGroupId) {
                const sentMsg = await this.sendMessageToWppGroup(session, chat.wppGroupId, data, savedMsg);
                sentMsg?.wwebjsId &&
                    (await prisma_service_1.default.internalMessage.update({
                        where: { id: savedMsg.id },
                        data: {
                            wwebjsIdStanza: sentMsg.wwebjsIdStanza ?? null,
                            wwebjsId: sentMsg.wwebjsId
                        }
                    }));
            }
        }
        catch (err) {
            const msg = (0, utils_1.sanitizeErrorMessage)(err) || "null";
            process.log("Erro ao enviar mensagem: " + msg);
            process.failed(err);
            throw new http_errors_1.BadRequestError("Erro ao enviar mensagem " + msg);
        }
    }
    async receiveMessage(groupId, msg, authorName) {
        const chat = await prisma_service_1.default.internalChat.findUnique({
            where: {
                wppGroupId: groupId
            }
        });
        if (chat) {
            const { to, ...rest } = msg;
            const savedMsg = await prisma_service_1.default.internalMessage.create({
                data: {
                    ...rest,
                    from: `external:${msg.from}:${authorName}`,
                    internalChatId: chat.id
                }
            });
            const room = `${msg.instance}:internal-chat:${chat.id}`;
            await socket_service_1.default.emit(sdk_1.SocketEventType.InternalMessage, room, {
                message: savedMsg
            });
        }
    }
    async sendMessageToWppGroup(session, groupId, data, message) {
        const client = await whatsapp_service_1.default.getClientBySector(session.instance, session.sectorId);
        if (!(client instanceof wwebjs_whatsapp_client_1.default)) {
            return;
        }
        let waMentions = [];
        if (data.mentions) {
            let mentions = [];
            if (typeof data.mentions === "string") {
                mentions = JSON.parse(data.mentions);
            }
            else if (Array.isArray(data.mentions)) {
                mentions = data.mentions;
            }
            waMentions = mentions.map(m => ({
                userId: m.userId ?? "",
                phone: m.phone ?? "",
                name: m.name || m.phone || ""
            }));
        }
        const text = `*${session.name}*: ${message.body}`;
        if (data.quotedId) {
            const quotedmsg = await prisma_service_1.default.internalMessage.findUnique({
                where: { id: +data.quotedId }
            });
            data.quotedId = quotedmsg?.wwebjsId || null;
        }
        if (groupId && client && message.fileId && message.fileName) {
            const fileUrl = files_service_1.default.getFileDownloadUrl(message.fileId);
            return await client.sendMessage({
                fileName: message.fileName,
                fileUrl,
                to: groupId,
                quotedId: data.quotedId || null,
                sendAsAudio: data.sendAsAudio === "true",
                sendAsDocument: data.sendAsDocument === "true",
                text,
                mentions: waMentions
            }, true);
        }
        else if (groupId && client) {
            return await client.sendMessage({
                to: groupId,
                quotedId: data.quotedId || null,
                text,
                mentions: waMentions
            }, true);
        }
        return await client.sendMessage({
            to: groupId,
            quotedId: data.quotedId || null,
            text: data.text,
            mentions: waMentions
        });
    }
    async updateMessage(id, data) {
        return await prisma_service_1.default.internalMessage.update({
            where: { id },
            data
        });
    }
    async markChatMessagesAsRead(chatId, userId) {
        const lastMsg = await prisma_service_1.default.internalMessage.findFirst({
            where: {
                internalChatId: chatId
            },
            orderBy: {
                timestamp: "desc"
            }
        });
        await prisma_service_1.default.internalChatMember.update({
            data: {
                lastReadAt: lastMsg?.timestamp
                    ? new Date(+lastMsg.timestamp)
                    : new Date()
            },
            where: {
                internalChatId_userId: {
                    internalChatId: chatId,
                    userId
                }
            }
        });
    }
}
exports.default = new InternalChatsService();
