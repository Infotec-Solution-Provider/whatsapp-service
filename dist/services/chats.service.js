"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FETCH_CUSTOMERS_QUERY = void 0;
const prisma_service_1 = __importDefault(require("./prisma.service"));
const sdk_1 = require("@in.pulse-crm/sdk");
const customers_service_1 = __importDefault(require("./customers.service"));
const instances_service_1 = __importDefault(require("./instances.service"));
const socket_service_1 = __importDefault(require("./socket.service"));
const messages_distribution_service_1 = __importDefault(require("./messages-distribution.service"));
const users_service_1 = __importDefault(require("./users.service"));
const whatsapp_service_1 = __importDefault(require("./whatsapp.service"));
const processing_logger_1 = __importDefault(require("../utils/processing-logger"));
exports.FETCH_CUSTOMERS_QUERY = "SELECT * FROM clientes WHERE CODIGO IN (?)";
const FETCH_RESULT_QUERY = "SELECT * FROM resultados WHERE CODIGO = ?";
class ChatsService {
    async getChatForContact(clientId, contact) {
        return await prisma_service_1.default.wppChat.findFirst({
            where: {
                contactId: contact.id,
                isFinished: false,
                sector: {
                    WppInstance: {
                        id: clientId
                    }
                }
            }
        });
    }
    async getUserChatsBySession(session, includeMessages = true, includeContact = true) {
        const foundChats = await prisma_service_1.default.wppChat.findMany({
            where: {
                isFinished: false,
                instance: session.instance,
                OR: [
                    {
                        userId: session.userId
                    },
                    {
                        wallet: {
                            WppWalletUser: {
                                some: {
                                    userId: session.userId
                                }
                            }
                        }
                    }
                ]
            },
            include: {
                contact: {
                    include: {
                        WppMessage: true
                    }
                },
                schedule: true
            }
        });
        if (session.role === "ADMIN") {
            const foundAdminChats = await prisma_service_1.default.wppChat.findMany({
                where: {
                    isFinished: false,
                    sectorId: session.sectorId,
                    userId: -1
                },
                include: {
                    contact: {
                        include: {
                            WppMessage: true
                        }
                    },
                    schedule: true
                }
            });
            foundChats.push(...foundAdminChats);
        }
        const chats = [];
        const messages = [];
        const customerIds = includeContact
            ? foundChats
                .filter((chat) => typeof chat.contact?.customerId === "number")
                .map((c) => c.contact.customerId)
            : [];
        const customers = customerIds.length
            ? await instances_service_1.default.executeQuery(session.instance, exports.FETCH_CUSTOMERS_QUERY, [
                foundChats
                    .filter((chat) => typeof chat.contact?.customerId === "number")
                    .map((c) => c.contact.customerId)
            ])
            : [];
        for (const foundChat of foundChats) {
            const { contact, ...chat } = foundChat;
            let customer = null;
            if (includeContact && typeof contact?.customerId == "number") {
                customer =
                    customers.find((c) => c.CODIGO === contact.customerId) ||
                        null;
            }
            chats.push({ ...chat, customer, contact: contact || null });
            if (includeMessages && contact) {
                const decodedMessages = contact.WppMessage.map((msg) => {
                    if (session.instance === "vollo" &&
                        typeof msg.body === "string") {
                        try {
                            return {
                                ...msg,
                                body: decodeURIComponent(msg.body)
                            };
                        }
                        catch (e) {
                            return msg;
                        }
                    }
                    return msg;
                });
                messages.push(...decodedMessages);
            }
        }
        return { chats, messages };
    }
    async getChatsMonitor(session, includeMessages = true, includeCustomer = true, includeFinished = false) {
        const isTI = session.sectorId === 3 || session.instance !== "nunes";
        const foundChats = await prisma_service_1.default.wppChat.findMany({
            where: {
                instance: session.instance,
                ...(isTI ? {} : { sectorId: session.sectorId }),
                ...(includeFinished ? {} : { isFinished: false })
            },
            include: {
                contact: {
                    include: {
                        WppMessage: includeMessages
                    }
                },
                schedule: true
            }
        });
        const chats = [];
        const messages = [];
        const customerIds = includeCustomer
            ? foundChats
                .filter((chat) => typeof chat.contact?.customerId === "number")
                .map((c) => c.contact.customerId)
            : [];
        const customers = customerIds.length
            ? await instances_service_1.default.executeQuery(session.instance, exports.FETCH_CUSTOMERS_QUERY, [
                foundChats
                    .filter((chat) => typeof chat.contact?.customerId === "number")
                    .map((c) => c.contact.customerId)
            ])
            : [];
        for (const foundChat of foundChats) {
            const { contact, ...chat } = foundChat;
            let customer = null;
            if (includeCustomer && typeof contact?.customerId == "number") {
                customer =
                    customers.find((c) => c.CODIGO === contact.customerId) ||
                        null;
            }
            chats.push({ ...chat, customer, contact: contact || null });
            if (includeMessages && contact) {
                const decodedMessages = contact.WppMessage.map((msg) => {
                    if (session.instance === "vollo" &&
                        typeof msg.body === "string") {
                        try {
                            return {
                                ...msg,
                                body: decodeURIComponent(msg.body)
                            };
                        }
                        catch (e) {
                            return msg;
                        }
                    }
                    return msg;
                });
                messages.push(...decodedMessages);
            }
        }
        return { chats, messages };
    }
    async getChats(filters) {
        const whereClause = {};
        if (filters.userId) {
            whereClause.userId = +filters.userId;
        }
        if (filters.isFinished) {
            whereClause.isFinished =
                filters.isFinished === "true" ? true : false;
        }
        const chats = await prisma_service_1.default.wppChat.findMany({
            include: {
                messages: true,
                contact: true,
                schedule: true
            },
            where: whereClause
        });
        return chats;
    }
    async getChatById(id) {
        const chat = await prisma_service_1.default.wppChat.findUnique({
            where: { id },
            include: {
                contact: true
            }
        });
        const messages = chat?.contactId
            ? await prisma_service_1.default.wppMessage.findMany({
                where: { contactId: chat?.contactId },
                orderBy: { timestamp: "asc" }
            })
            : [];
        if (chat?.contact?.customerId) {
            try {
                const customer = await customers_service_1.default.getCustomerById(chat.contact.customerId);
                return { ...chat, customer, messages };
            }
            catch (err) {
                return { ...chat, messages };
            }
        }
        return { ...chat, messages };
    }
    async transferAttendance(token, session, id, userId) {
        const { instance } = session;
        users_service_1.default.setAuth(token);
        const chats = await prisma_service_1.default.wppChat.findUnique({
            where: { id }
        });
        if (!chats) {
            throw new Error("Chat não encontrado!");
        }
        if (!chats.userId) {
            throw new Error("Chat não possui userId!");
        }
        const user = await users_service_1.default.getUserById(chats.userId);
        const chat = await prisma_service_1.default.wppChat.update({
            where: { id },
            data: {
                userId
            }
        });
        const event = sdk_1.SocketEventType.WppChatTransfer;
        const monitorRoom = `${chat.instance}:${chat.sectorId}:monitor`;
        if (chat.userId === null || chat.userId === undefined) {
            throw new Error("chat.userId is null or undefined, cannot construct userRoom.");
        }
        const userRoom = `${chat.instance}:user:${chat.userId}`;
        const transferMsg = `Atendimento transferido por ${user.NOME}.`;
        await messages_distribution_service_1.default.addSystemMessage(chat, transferMsg);
        await socket_service_1.default.emit(event, `${instance}:chat:${chat.id}`, {
            chatId: chat.id
        });
        await socket_service_1.default.emit(sdk_1.SocketEventType.WppChatStarted, monitorRoom, {
            chatId: chat.id
        });
        await socket_service_1.default.emit(sdk_1.SocketEventType.WppChatStarted, userRoom, {
            chatId: chat.id
        });
    }
    async finishChatById(token, session, id, resultId) {
        const results = await instances_service_1.default.executeQuery(session.instance, FETCH_RESULT_QUERY, [resultId]);
        const { instance, userId } = session;
        users_service_1.default.setAuth(token || "");
        const user = resultId !== -50 && (await users_service_1.default.getUserById(userId));
        const chat = await prisma_service_1.default.wppChat.update({
            where: { id },
            data: {
                isFinished: true,
                finishedAt: new Date(),
                finishedBy: userId,
                resultId
            }
        });
        const event = sdk_1.SocketEventType.WppChatFinished;
        let finishMsg = "";
        if (!user && resultId === -50) {
            finishMsg = `Atendimento finalizado pelo sistema.`;
        }
        if (user) {
            finishMsg = `Atendimento finalizado por ${user.NOME}.\nResultado: ${results[0]?.NOME || "N/D"} `;
        }
        await messages_distribution_service_1.default.addSystemMessage(chat, finishMsg);
        await socket_service_1.default.emit(event, `${instance}:chat:${chat.id}`, {
            chatId: chat.id
        });
    }
    async startChatByContactId(session, token, contactId, template) {
        const process = new processing_logger_1.default(session.instance, "start-chat", `${session.userId}-${contactId}_${Date.now()}`, { session, contactId, token });
        try {
            const contact = await prisma_service_1.default.wppContact.findUnique({
                where: { id: contactId }
            });
            if (!contact) {
                throw new Error("Contato não encontrado!");
            }
            const existingChat = await prisma_service_1.default.wppChat.findFirst({
                where: {
                    instance: session.instance,
                    contactId,
                    isFinished: false
                }
            });
            if (existingChat) {
                throw new Error("Alguém já está atendendo esse contato!");
            }
            const profilePicture = await whatsapp_service_1.default.getProfilePictureUrl(session.instance, contact.phone);
            const newChat = await prisma_service_1.default.wppChat.create({
                data: {
                    instance: session.instance,
                    type: "ACTIVE",
                    avatarUrl: profilePicture,
                    userId: session.userId,
                    contactId,
                    sectorId: session.sectorId,
                    startedAt: new Date()
                },
                include: {
                    contact: true,
                    messages: {
                        where: {
                            contactId: contact.id
                        }
                    }
                }
            });
            users_service_1.default.setAuth(token);
            const user = await users_service_1.default.getUserById(session.userId);
            const message = `Atendimento iniciado por ${user.NOME}.`;
            await messages_distribution_service_1.default.addSystemMessage(newChat, message, true);
            console.log("contact", newChat.contact);
            if (template && newChat.contact) {
                await whatsapp_service_1.default.sendTemplate(session, newChat.contact.phone, template, newChat.id, newChat.contact.id);
            }
            await messages_distribution_service_1.default.notifyChatStarted(process, newChat);
        }
        catch (err) {
            process.log("Erro ao iniciar o atendimento ");
            process.failed(err);
        }
    }
    async startScheduledChat(instance, sectorId, contactId, scheduledFor) {
        const process = new processing_logger_1.default(instance, "start-chat", `${scheduledFor}-${contactId}_${Date.now()}`, { instance, contactId, scheduledFor });
        try {
            const contact = await prisma_service_1.default.wppContact.findUnique({
                where: { id: contactId }
            });
            if (!contact) {
                throw new Error("Contato não encontrado!");
            }
            const existingChat = await prisma_service_1.default.wppChat.findFirst({
                where: {
                    instance,
                    contactId,
                    isFinished: false,
                    isSchedule: true
                }
            });
            if (existingChat) {
                throw new Error("Alguém já está atendendo esse contato!");
            }
            const profilePicture = await whatsapp_service_1.default.getProfilePictureUrl(instance, contact.phone);
            const newChat = await prisma_service_1.default.wppChat.create({
                data: {
                    instance,
                    type: "ACTIVE",
                    avatarUrl: profilePicture,
                    userId: scheduledFor,
                    contactId,
                    sectorId,
                    startedAt: new Date(),
                    isSchedule: true
                }
            });
            const message = `Atendimento iniciado pelo sistema.\nMotivo: Retorno agendado.`;
            await messages_distribution_service_1.default.addSystemMessage(newChat, message, true);
            const newChatWithDetails = await prisma_service_1.default.wppChat.findUnique({
                where: { id: newChat.id },
                include: {
                    contact: true,
                    messages: {
                        where: {
                            contactId
                        }
                    }
                }
            });
            let customer = null;
            if (contact.customerId) {
                try {
                    const customers = await instances_service_1.default.executeQuery(instance, exports.FETCH_CUSTOMERS_QUERY, [[contact.customerId]]);
                    customer = customers[0] || null;
                }
                catch (err) {
                    customer = null;
                }
            }
            const chatWithCustomer = { ...newChatWithDetails, customer };
            await messages_distribution_service_1.default.notifyChatStarted(process, chatWithCustomer);
            return newChatWithDetails.id;
        }
        catch (err) {
            process.log("Erro ao iniciar o atendimento ");
            process.failed(err);
            return null;
        }
    }
}
exports.default = new ChatsService();
