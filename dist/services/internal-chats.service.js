"use strict";
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
const whatsapp_service_1 = require("./whatsapp.service");
class InternalChatsService {
    async createInternalChat(session, participantIds, isGroup = false, groupName = "") {
        const internalChat = await prisma_service_1.default.internalChat.create({
            data: {
                isGroup,
                groupName,
                creatorId: session.userId,
                instance: session.instance,
                participants: {
                    createMany: {
                        data: participantIds.map((id) => ({
                            userId: id,
                            joinedAt: new Date()
                        }))
                    }
                }
            },
            include: {
                participants: true
            }
        });
        participantIds.forEach(async (id) => {
            const room = `${session.instance}:user:${id}`;
            await socket_service_1.default.emit(sdk_1.SocketEventType.InternalChatStarted, room, {
                chat: {
                    ...internalChat,
                    participants: participantIds
                }
            });
        });
        return internalChat;
    }
    async updateInternalChatParticipants(groupId, { name, participants }) {
        const currentParticipants = await prisma_service_1.default.internalChatMember.findMany({
            where: {
                internalChatId: groupId
            }
        });
        const idsToAdd = participants.filter((p) => !currentParticipants.some((c) => c.userId === p));
        const idsToRemove = currentParticipants.filter((p) => !participants.includes(p.userId));
        const group = await prisma_service_1.default.internalChat.update({
            where: { id: groupId },
            data: {
                groupName: name,
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
            include: { participants: true }
        });
        return group;
    }
    async getInternalChatsBySession(session) {
        const result = await prisma_service_1.default.internalChat.findMany({
            where: {
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
        result.forEach((chat) => {
            const { messages: msgs, participants, ...rest } = chat;
            messages.push(...msgs);
            chats.push({
                ...rest,
                participants: participants.map((p) => p.userId)
            });
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
                participants: true
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
            let message = {
                instance: session.instance,
                status: "RECEIVED",
                timestamp: Date.now().toString(),
                from: `user:${session.userId}`,
                type: "chat",
                body: data.text || "",
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
                const file = await files_service_1.default.uploadFile({
                    instance: session.instance,
                    fileName: data.file.originalname,
                    buffer: data.file.buffer,
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
            const room = `${session.instance}:internal-chat:${data.chatId}`;
            await socket_service_1.default.emit(sdk_1.SocketEventType.InternalMessage, room, {
                message: savedMsg
            });
            process.success("Mensagem enviada com sucesso.");
        }
        catch (err) {
            const msg = (0, utils_1.sanitizeErrorMessage)(err) || "null";
            process.log("Erro ao enviar mensagem: " + msg);
            process.failed(err);
            throw new http_errors_1.BadRequestError("Erro ao enviar mensagem " + msg);
        }
    }
    async updateMessage(id, data) {
        return await prisma_service_1.default.internalMessage.update({
            where: { id },
            data
        });
    }
}
exports.default = new InternalChatsService();
