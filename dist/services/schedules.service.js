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
const prisma_service_1 = __importDefault(require("./prisma.service"));
const sdk_1 = require("@in.pulse-crm/sdk");
const chats_service_1 = __importStar(require("./chats.service"));
const messages_distribution_service_1 = __importDefault(require("./messages-distribution.service"));
const node_cron_1 = __importDefault(require("node-cron"));
const socket_service_1 = __importDefault(require("./socket.service"));
const utils_1 = require("@in.pulse-crm/utils");
const whatsapp_service_1 = __importDefault(require("./whatsapp.service"));
const choose_sector_bot_1 = __importDefault(require("../bots/choose-sector.bot"));
const instances_service_1 = __importDefault(require("./instances.service"));
class SchedulesService {
    constructor() {
        node_cron_1.default.schedule("*/5 * * * *", async () => {
            this.runSchedulesJob();
            this.finishChatRoutine();
        });
    }
    async runSchedulesJob() {
        const schedules = await prisma_service_1.default.wppSchedule.findMany({
            where: {
                chatId: null,
                scheduleDate: {
                    lte: new Date()
                }
            }
        });
        for (const schedule of schedules) {
            const chat = await prisma_service_1.default.wppChat.findFirst({
                where: {
                    contactId: schedule.contactId,
                    instance: schedule.instance,
                    isFinished: false
                }
            });
            if (chat) {
                await chats_service_1.default.finishChatById(null, {
                    instance: schedule.instance,
                    userId: schedule.scheduledBy,
                    sectorId: schedule.sectorId,
                    role: "ADMIN",
                    name: "SYSTEM"
                }, chat.id, -50);
            }
            const chatId = await chats_service_1.default.startScheduledChat(schedule.instance, schedule.sectorId, schedule.contactId, schedule.scheduledFor);
            if (chatId) {
                await prisma_service_1.default.wppSchedule.update({
                    where: {
                        id: schedule.id
                    },
                    data: {
                        chatId
                    }
                });
            }
        }
    }
    async getSchedulesBySession(session, filters) {
        const whereClause = {
            chat: null
        };
        whereClause.instance = session.instance;
        if (filters.userId) {
            whereClause.scheduledFor = +filters.userId;
        }
        if (filters.sectorId) {
            whereClause.sectorId = +filters.sectorId;
        }
        const schedules = await prisma_service_1.default.wppSchedule.findMany({
            where: whereClause,
            include: {
                contact: true
            }
        });
        const detailedSchedules = [];
        const customerIds = schedules
            .filter((chat) => typeof chat.contact?.customerId === "number")
            .map((c) => c.contact.customerId);
        const customers = customerIds.length
            ? await instances_service_1.default.executeQuery(session.instance, chats_service_1.FETCH_CUSTOMERS_QUERY, [customerIds])
            : [];
        for (const schedule of schedules) {
            const { contact, ...s } = schedule;
            let customer = null;
            if (typeof contact?.customerId == "number") {
                customer =
                    customers.find((c) => c.CODIGO === contact.customerId) ||
                        null;
            }
            detailedSchedules.push({
                ...s,
                customer,
                contact: contact || null
            });
        }
        return detailedSchedules;
    }
    async finishChatRoutine() {
        const agora = new Date();
        const trintaMinAtras = new Date(agora.getTime() - 30 * 60 * 1000);
        const duasHorasAtras = new Date(agora.getTime() - 48 * 60 * 60 * 1000);
        const chats = await prisma_service_1.default.wppChat.findMany({
            where: {
                instance: "nunes",
                isFinished: false,
                startedAt: {
                    gte: duasHorasAtras,
                    lte: trintaMinAtras
                }
            },
            include: {
                messages: {
                    select: {
                        from: true,
                        timestamp: true,
                        body: true
                    }
                }
            }
        });
        utils_1.Logger.debug(`[CRON] Verificando chats inativos...`);
        utils_1.Logger.debug(`[CRON] Chats encontrados: ${chats.length}`);
        utils_1.Logger.debug(`[CRON] Chats encontrados: ${JSON.stringify(chats)}`);
        for (const chat of chats) {
            const teveMensagemDeOperador = chat.messages.some((msg) => msg.from.startsWith("me:"));
            utils_1.Logger.debug(`[CRON] Chat ${chat.id} - Teve mensagem de operador: ${teveMensagemDeOperador}`);
            if (!teveMensagemDeOperador) {
                await prisma_service_1.default.wppChat.update({
                    where: { id: chat.id },
                    data: {
                        isFinished: true,
                        finishedAt: new Date(),
                        finishedBy: null
                    }
                });
                utils_1.Logger.debug(`[CRON] Chat ${chat.id} finalizado automaticamente.`);
                const event = sdk_1.SocketEventType.WppChatFinished;
                let finishMsg = `Atendimento finalizado pelo sistema devido inatividade do operador.`;
                utils_1.Logger.debug("Mensagem de finalização:", finishMsg);
                await messages_distribution_service_1.default.addSystemMessage(chat, finishMsg);
                await socket_service_1.default.emit(event, `${chat.instance}:chat:${chat.id}`, {
                    chatId: chat.id
                });
                const contact = await prisma_service_1.default.wppContact.findUnique({
                    where: {
                        id: chat.contactId
                    }
                });
                await prisma_service_1.default.notification.create({
                    data: {
                        instance: chat.instance,
                        title: "Atendimento finalizado automaticamente",
                        description: `O chat com ${contact ? contact.name : chat.contactId} do contato, foi finalizado por inatividade do operador.`,
                        chatId: chat.id,
                        type: "CHAT_AUTO_FINISHED",
                        userId: chat.userId ?? null
                    }
                });
            }
            else {
                const jaMandouPrompt = chat.messages.some((m) => {
                    const texto = m.body?.toLowerCase().trim();
                    return texto?.includes("deseja voltar ao menu de setores");
                });
                if (jaMandouPrompt) {
                    const mensagensOrdenadas = chat.messages
                        .filter((m) => m.timestamp)
                        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
                    const ultimaMensagem = mensagensOrdenadas[0];
                    const agora = new Date();
                    const quinzeMinutosAtras = new Date(agora.getTime() - 15 * 60 * 1000);
                    const deveEncerrar = ultimaMensagem !== undefined &&
                        Number(ultimaMensagem.timestamp) <= quinzeMinutosAtras.getTime();
                    utils_1.Logger.debug("[CRON] Verificação de encerramento simplificada:");
                    utils_1.Logger.debug(`[CRON] Agora: ${agora.toISOString()} | ${agora.getTime()}`);
                    utils_1.Logger.debug(`[CRON] 15min atrás: ${quinzeMinutosAtras.toISOString()} | ${quinzeMinutosAtras.getTime()}`);
                    utils_1.Logger.debug(`[CRON] Última mensagem: ${ultimaMensagem?.body}`);
                    utils_1.Logger.debug(`[CRON] Timestamp: ${ultimaMensagem?.timestamp ?? 'nenhum'}`);
                    utils_1.Logger.debug(`[CRON] Deve encerrar? ${deveEncerrar}`);
                    if (deveEncerrar) {
                        await prisma_service_1.default.wppChat.update({
                            where: { id: chat.id },
                            data: {
                                isFinished: true,
                                finishedAt: new Date(),
                                finishedBy: null
                            }
                        });
                        utils_1.Logger.debug(`[CRON] Chat ${chat.id} finalizado automaticamente após 15 minutos sem resposta do cliente ou operador.`);
                        const event = sdk_1.SocketEventType.WppChatFinished;
                        const finishMsg = "Atendimento finalizado automaticamente após 15 minutos sem resposta do cliente e operador.";
                        await messages_distribution_service_1.default.addSystemMessage(chat, finishMsg);
                        await socket_service_1.default.emit(event, `${chat.instance}:chat:${chat.id}`, { chatId: chat.id });
                        const contact = await prisma_service_1.default.wppContact.findUnique({
                            where: { id: chat.contactId }
                        });
                        await prisma_service_1.default.notification.create({
                            data: {
                                instance: chat.instance,
                                title: "Atendimento finalizado automaticamente",
                                description: `O chat com ${contact ? contact.name : chat.contactId} do contato, foi finalizado por inatividade após envio do menu.`,
                                chatId: chat.id,
                                type: "CHAT_AUTO_FINISHED",
                                userId: chat.userId ?? null
                            }
                        });
                        continue;
                    }
                    else {
                        utils_1.Logger.debug(`[CRON] Chat ${chat.id} ainda aguardando resposta do cliente ou operador após envio do menu.`);
                        continue;
                    }
                }
                const trintaMinAtras = new Date(Date.now() - 30 * 60 * 1000);
                const mensagensOrdenadas = chat.messages
                    .filter((m) => m.timestamp)
                    .sort((a, b) => new Date(b.timestamp).getTime() -
                    new Date(a.timestamp).getTime());
                const ultimaMensagem = mensagensOrdenadas[0];
                if (!ultimaMensagem)
                    continue;
                if (ultimaMensagem.from.startsWith("me:")) {
                    const ultimaData = new Date(ultimaMensagem.timestamp);
                    if (ultimaData <= trintaMinAtras) {
                        const awaitClient = "O cliente está aguardando há mais de 30 minutos após sua última resposta. Deseja encerrar ou continuar o atendimento?";
                        await messages_distribution_service_1.default.addSystemMessage(chat, awaitClient);
                        continue;
                    }
                    else {
                        utils_1.Logger.debug(`[CRON] Chat ${chat.id} - Operador respondeu recentemente`);
                        continue;
                    }
                }
                const client = chat.messages.find((m) => !m.from.startsWith("me:") &&
                    !m.from.startsWith("bot:") &&
                    !m.from.startsWith("system"));
                if (!client)
                    continue;
                await whatsapp_service_1.default.sendBotMessage(client.from, {
                    chat,
                    text: [
                        "Deseja voltar ao menu de setores, finalizar conversa ou aguardar resposta do contato?",
                        "",
                        "*1* - Voltar ao menu de setores",
                        "*2* - Finalizar conversa",
                        "*3* - Aguardar resposta do contato",
                        "",
                        "*Responda apenas com o número da opção desejada.*"
                    ].join("\n")
                });
                await prisma_service_1.default.wppChat.update({
                    where: { id: chat.id },
                    data: { botId: 1 }
                });
                choose_sector_bot_1.default.forceStep(chat.id, 4, chat.userId ?? 0);
            }
        }
    }
    async createSchedule(token, session, data) {
        const chat = await prisma_service_1.default.wppChat.findFirst({
            where: {
                contactId: data.contactId,
                instance: session.instance,
                isFinished: false
            }
        });
        const date = new Date(data.date);
        const schedules = await prisma_service_1.default.wppSchedule.create({
            data: {
                instance: session.instance,
                scheduledBy: session.userId,
                scheduledFor: data.scheduledFor,
                scheduleDate: date,
                contactId: data.contactId,
                sectorId: session.sectorId,
                scheduledAt: new Date()
            }
        });
        if (chat) {
            await chats_service_1.default.finishChatById(token, session, chat.id, -50);
            await messages_distribution_service_1.default.addSystemMessage(chat, "Retorno agendado para: " + date.toLocaleString(), true);
        }
        return schedules;
    }
    async getAllSchedules() {
        const schedules = await prisma_service_1.default.wppSchedule.findMany({
            where: {
                chatId: null
            },
            include: {
                contact: true,
                sector: true,
                chat: true
            },
            orderBy: {
                scheduleDate: "asc"
            }
        });
        return schedules;
    }
    async editSchedule(scheduleData, scheduleId) {
        const schedules = await prisma_service_1.default.wppSchedule.update({
            where: { id: scheduleId },
            data: scheduleData
        });
        return schedules;
    }
    async deleteSchedule(scheduleId) {
        const schedules = await prisma_service_1.default.wppSchedule.delete({
            where: { id: scheduleId }
        });
        return schedules;
    }
}
exports.default = new SchedulesService();
