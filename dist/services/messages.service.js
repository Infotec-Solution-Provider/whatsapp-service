"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = __importDefault(require("./prisma.service"));
const sdk_1 = require("@in.pulse-crm/sdk");
const http_errors_1 = require("@rgranatodutra/http-errors");
const socket_service_1 = __importDefault(require("./socket.service"));
class MessagesService {
    async insertMessage(data) {
        return await prisma_service_1.default.wppMessage.create({ data });
    }
    async updateMessage(id, data) {
        return await prisma_service_1.default.wppMessage.update({
            where: { id },
            data
        });
    }
    async markContactMessagesAsRead(instance, contactId) {
        await prisma_service_1.default.wppMessage.updateMany({
            where: {
                OR: [
                    {
                        to: {
                            startsWith: "me:"
                        }
                    },
                    {
                        to: "system"
                    }
                ],
                WppChat: {
                    instance,
                    contactId
                }
            },
            data: {
                status: "READ"
            }
        });
        const chat = await prisma_service_1.default.wppChat.findFirst({
            where: {
                instance,
                contactId,
                isFinished: false
            }
        });
        if (chat) {
            const room = `${instance}:chat:${chat.id}`;
            socket_service_1.default.emit(sdk_1.SocketEventType.WppContactMessagesRead, room, {
                contactId
            });
        }
    }
    async getMessageById(session, id) {
        const message = await prisma_service_1.default.wppMessage.findUnique({
            where: { id }
        });
        if (!message) {
            throw new http_errors_1.NotFoundError("Message not found!");
        }
        if (message.instance !== session.instance) {
            throw new http_errors_1.UnauthorizedError("This message does not belong to your instance!");
        }
        return message;
    }
}
exports.default = new MessagesService();
