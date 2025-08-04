"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = __importDefault(require("./prisma.service"));
const sdk_1 = require("@in.pulse-crm/sdk");
const customers_service_1 = __importDefault(require("./customers.service"));
const instances_service_1 = __importDefault(require("./instances.service"));
const socket_service_1 = __importDefault(require("./socket.service"));
const messages_distribution_service_1 = __importDefault(require("./messages-distribution.service"));
const users_service_1 = __importDefault(require("./users.service"));
const whatsapp_service_1 = __importDefault(require("./whatsapp.service"));
const FETCH_CUSTOMERS_QUERY = "SELECT * FROM clientes WHERE CODIGO IN (?)";
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
                }
            }
        });
        if (session.role === "ADMIN") {
            const foundAdminChats = await prisma_service_1.default.wppChat.findMany({
                where: {
                    userId: -1,
                    sectorId: session.sectorId,
                    isFinished: false
                },
                include: {
                    contact: {
                        include: {
                            WppMessage: true
                        }
                    }
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
            ? await instances_service_1.default.executeQuery(session.instance, FETCH_CUSTOMERS_QUERY, [
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
                messages.push(...contact.WppMessage);
            }
        }
        return { chats, messages };
    }
    async getChatsMonitor(session) {
        const foundChats = await prisma_service_1.default.wppChat.findMany({
            where: {
                instance: session.instance,
                sectorId: session.sectorId,
                isFinished: false
            },
            include: {
                contact: true
            }
        });
        const customerIds = foundChats
            .filter((chat) => typeof chat.contact?.customerId === "number")
            .map((chat) => chat.contact.customerId);
        const customers = customerIds.length
            ? await instances_service_1.default.executeQuery(session.instance, FETCH_CUSTOMERS_QUERY, [customerIds])
            : [];
        const monitorChats = foundChats.map((chat) => {
            const customer = customers.find((c) => c.CODIGO === chat.contact?.customerId);
            return {
                id: chat.id.toString(),
                erpCode: customer?.CODIGO?.toString() || "",
                companyName: customer?.RAZAO || "",
                contactName: chat.contact?.name || "",
                whatsappNumber: chat.contact?.name || "",
                sectorName: customer?.SETOR || "",
                attendantName: chat.userId || "",
                startDate: chat.startedAt?.toISOString() || "",
                endDate: chat.finishedAt?.toISOString() || "",
                result: chat.resultId || ""
            };
        });
        return monitorChats;
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
                contact: true
            },
            where: whereClause
        });
        return chats;
    }
    async getChatById(id) {
        const chat = await prisma_service_1.default.wppChat.findUnique({
            where: { id },
            include: {
                messages: true,
                contact: true
            }
        });
        if (chat?.contact?.customerId) {
            try {
                const customer = await customers_service_1.default.getCustomerById(chat.contact.customerId);
                return { ...chat, customer };
            }
            catch (err) {
                return chat;
            }
        }
        return chat;
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
        const event = sdk_1.SocketEventType.WppChatFinished;
        const transferMsg = `Atendimento tranferido por ${user.NOME}.`;
        await messages_distribution_service_1.default.addSystemMessage(chat, transferMsg);
        await socket_service_1.default.emit(event, `${instance}:chat:${chat.id}`, {
            chatId: chat.id
        });
    }
    async finishChatById(token, session, id, resultId) {
        const results = await instances_service_1.default.executeQuery(session.instance, FETCH_RESULT_QUERY, [resultId]);
        const { instance, userId } = session;
        users_service_1.default.setAuth(token);
        const user = await users_service_1.default.getUserById(userId);
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
        const finishMsg = `Atendimento finalizado por ${user.NOME}.\nResultado: ${results[0]?.NOME || "N/D"} `;
        await messages_distribution_service_1.default.addSystemMessage(chat, finishMsg);
        await socket_service_1.default.emit(event, `${instance}:chat:${chat.id}`, {
            chatId: chat.id
        });
    }
    async startChatByContactId(session, token, contactId) {
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
            }
        });
        users_service_1.default.setAuth(token);
        const user = await users_service_1.default.getUserById(session.userId);
        const message = `Atendimento iniciado por ${user.NOME}.`;
        await messages_distribution_service_1.default.addSystemMessage(newChat, message, true);
        const newChatWithDetails = await prisma_service_1.default.wppChat.findUnique({
            where: { id: newChat.id },
            include: {
                contact: true,
                messages: true
            }
        });
        let customer = null;
        if (contact.customerId) {
            try {
                customers_service_1.default.setAuth(token);
                customer = await customers_service_1.default.getCustomerById(contact.customerId);
            }
            catch (err) {
                customer = null;
            }
        }
        return { ...newChatWithDetails, customer };
    }
}
exports.default = new ChatsService();
