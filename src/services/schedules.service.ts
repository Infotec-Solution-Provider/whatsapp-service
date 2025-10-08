import { Prisma, WppContact, WppSchedule } from "@prisma/client";
import prismaService from "./prisma.service";
import { CreateScheduleDTO, Customer, SessionData, SocketEventType } from "@in.pulse-crm/sdk";
import chatsService, { FETCH_CUSTOMERS_QUERY } from "./chats.service";
import messagesDistributionService from "./messages-distribution.service";
import cron from "node-cron";
import socketService from "./socket.service";
import whatsappService from "./whatsapp.service";
import chooseSectorBot from "../bots/choose-sector.bot";
import instancesService from "./instances.service";
import parametersService from "./parameters.service";
import JsonSessionStore from "../utils/json-session-store";
import ProcessingLogger from "../utils/processing-logger";

type ChatMonitoringSession = {
	chatId: number;
	instance: string;
	lastActivity: number;
	hasOperatorMessage: boolean;
	hasMenuPrompt: boolean;
	state: "monitoring" | "awaiting_response" | "menu_sent";
	timeouts: {
		inactivity: number; // tempo para considerar chat inativo (operador ou cliente)
		menuResponse: number; // tempo para aguardar resposta do menu
	};
	autoFinishEnabled: boolean; // se a finalização automática está habilitada
};

interface ChatsFilters {
	userId?: string;
	sectorId?: string;
}
class SchedulesService {
	private chatSessions = new Map<number, ChatMonitoringSession>();
	private sessionStore = new JsonSessionStore<ChatMonitoringSession>({
		filename: "chat-monitoring.sessions.json"
	});
	private initialized = false;

	constructor() {
		cron.schedule("*/10 * * * * *", async () => {
			this.runSchedulesJob();
			this.finishChatRoutine();
		});
	}

	private async ensureInitialized() {
		if (this.initialized) return;

		await this.sessionStore.ensureLoaded((sessions) => {
			this.chatSessions.clear();
			const now = Date.now();

			for (const session of sessions) {
				if (session && typeof session.chatId === "number") {
					this.chatSessions.set(session.chatId, {
						...session,
						lastActivity: session.lastActivity ?? now
					});
				}
			}
			this.initialized = true;
		});
	}

	private async getTimeoutConfig(instance: string, sectorId?: number, userId?: number) {
		try {
			const params = await parametersService.getSessionParams({
				instance,
				sectorId: sectorId ?? 0,
				userId: userId ?? 0,
				name: "",
				role: ""
			});

			return {
				timeouts: {
					inactivity: Number(params["CHAT_INACTIVITY_MS"] || 30 * 60 * 1000), // 30min
					menuResponse: Number(params["CHAT_MENU_RESPONSE_MS"] || 15 * 60 * 1000) // 15min
				},
				autoFinishEnabled: params["CHAT_AUTO_FINISH_ENABLED"] === "true"
			};
		} catch (error) {
			// Fallback para valores padrão se não conseguir buscar paâmetros
			return {
				timeouts: {
					inactivity: 30 * 60 * 1000, // 30min
					menuResponse: 15 * 60 * 1000 // 15min
				},
				autoFinishEnabled: false
			};
		}
	}

	private async getOrCreateSession(
		chatId: number,
		instance: string,
		sectorId?: number,
		userId?: number
	): Promise<ChatMonitoringSession> {
		let session = this.chatSessions.get(chatId);

		if (!session) {
			const config = await this.getTimeoutConfig(instance, sectorId, userId);
			session = {
				chatId,
				instance,
				lastActivity: Date.now(),
				hasOperatorMessage: false,
				hasMenuPrompt: false,
				state: "monitoring",
				timeouts: config.timeouts,
				autoFinishEnabled: config.autoFinishEnabled
			};
			this.chatSessions.set(chatId, session);
			this.sessionStore.scheduleSave(() => this.chatSessions.values());
		}

		return session;
	}

	private removeSession(chatId: number) {
		this.chatSessions.delete(chatId);
		this.sessionStore.scheduleSave(() => this.chatSessions.values());
	}

	private async finishChat(chat: any, reason: string, logger?: ProcessingLogger) {
		logger?.log(`Finalizando chat ${chat.id}: ${reason}`);

		await prismaService.wppChat.update({
			where: { id: chat.id },
			data: {
				isFinished: true,
				finishedAt: new Date(),
				finishedBy: null
			}
		});

		await messagesDistributionService.addSystemMessage(chat, reason);
		await socketService.emit(SocketEventType.WppChatFinished, `${chat.instance}:chat:${chat.id}`, {
			chatId: chat.id
		});

		const contact = await prismaService.wppContact.findUnique({
			where: { id: chat.contactId as number }
		});

		await prismaService.notification.create({
			data: {
				instance: chat.instance,
				title: "Atendimento finalizado automaticamente",
				description: `O chat com ${contact?.name || chat.contactId} foi finalizado: ${reason}`,
				chatId: chat.id,
				type: "CHAT_AUTO_FINISHED",
				userId: chat.userId ?? null
			}
		});

		this.removeSession(chat.id);
		logger?.success({ chatId: chat.id, reason });
	}

	private async runSchedulesJob() {
		const schedules = await prismaService.wppSchedule.findMany({
			where: {
				chatId: null,
				scheduleDate: {
					lte: new Date()
				}
			}
		});

		for (const schedule of schedules) {
			const chat = await prismaService.wppChat.findFirst({
				where: {
					contactId: schedule.contactId,
					instance: schedule.instance,
					isFinished: false
				}
			});

			if (chat) {
				await chatsService.finishChatById(
					null,
					{
						instance: schedule.instance,
						userId: schedule.scheduledBy,
						sectorId: schedule.sectorId!,
						role: "ADMIN",
						name: "SYSTEM"
					},
					chat.id,
					-50
				);
			}

			const chatId = await chatsService.startScheduledChat(
				schedule.instance,
				schedule.sectorId!,
				schedule.contactId,
				schedule.scheduledFor
			);

			if (chatId) {
				await prismaService.wppSchedule.update({
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

	public async getSchedulesBySession(session: SessionData, filters: ChatsFilters) {
		const whereClause: Prisma.WppScheduleWhereInput = {
			chat: null
		};

		whereClause.instance = session.instance;

		if (filters.userId) {
			whereClause.scheduledFor = +filters.userId;
		}

		if (filters.sectorId) {
			whereClause.sectorId = +filters.sectorId;
		}

		const schedules = await prismaService.wppSchedule.findMany({
			where: whereClause,
			include: {
				contact: true
			}
		});

		const detailedSchedules: Array<
			WppSchedule & {
				customer: Customer | null;
				contact: WppContact | null;
			}
		> = [];
		const customerIds = schedules
			.filter((chat) => typeof chat.contact?.customerId === "number")
			.map((c) => c.contact!.customerId!);

		const customers = customerIds.length
			? await instancesService.executeQuery<Array<Customer>>(session.instance, FETCH_CUSTOMERS_QUERY, [
					customerIds
				])
			: [];

		for (const schedule of schedules) {
			const { contact, ...s } = schedule;

			let customer: Customer | null = null;

			if (typeof contact?.customerId == "number") {
				customer = customers.find((c) => c.CODIGO === contact.customerId) || null;
			}

			detailedSchedules.push({
				...s,
				customer,
				contact: contact || null
			});
		}

		return detailedSchedules;
	}

	public async finishChatRoutine() {
		await this.ensureInitialized();

		const process = new ProcessingLogger("system", "chat-monitoring", `routine-${Date.now()}`, {
			operation: "finish-chat-routine"
		});

		try {
			process.log("Iniciando rotina de monitoramento de chats");

			// Busca chats ativos para análise - sem filtro de instância específica
			const activeChats = await this.getActiveChatsForMonitoring();
			process.log(`Encontrados ${activeChats.length} chats ativos para análise`);

			for (const chat of activeChats) {
				const chatLogger = new ProcessingLogger(
					chat.instance,
					"chat-monitoring",
					`chat-${chat.id}-${Date.now()}`,
					{ chatId: chat.id, instance: chat.instance }
				);

				try {
					await this.processChat(chat, chatLogger);
				} catch (error) {
					chatLogger.failed(error);
				}
			}

			process.success({ processedChats: activeChats.length });
		} catch (error) {
			process.failed(error);
		}
	}

	private async getActiveChatsForMonitoring() {
		return await prismaService.wppChat.findMany({
			where: {
				isFinished: false
			},
			include: {
				messages: {
					select: {
						from: true,
						timestamp: true,
						body: true
					},
					orderBy: {
						timestamp: "desc"
					}
				}
			}
		});
	}

	private async processChat(chat: any, process: ProcessingLogger) {
		const session = await this.getOrCreateSession(chat.id, chat.instance, chat.sectorId, chat.userId);

		process.log("Processando chat", {
			state: session.state,
			timeouts: session.timeouts
		});

		// Análise das mensagens do chat
		const messageAnalysis = this.analyzeMessages(chat.messages);

		// Atualiza estado da sessão baseado na análise
		session.hasOperatorMessage = messageAnalysis.hasOperatorMessage;
		session.hasMenuPrompt = messageAnalysis.hasMenuPrompt;
		session.lastActivity = messageAnalysis.lastActivity;

		this.sessionStore.scheduleSave(() => this.chatSessions.values());

		// Decisões baseadas no estado atual
		await this.makeDecision(chat, session, messageAnalysis, process);
	}

	private analyzeMessages(messages: any[]) {
		let hasOperatorMessage = false;
		let hasMenuPrompt = false;
		let lastActivity = 0;
		let lastMessage = null;
		let lastOperatorMessage = null;

		for (const message of messages) {
			const timestamp = new Date(message.timestamp).getTime();
			if (timestamp > lastActivity) {
				lastActivity = timestamp;
				lastMessage = message;
			}

			if (message.from.startsWith("me:")) {
				hasOperatorMessage = true;
				if (!lastOperatorMessage || timestamp > new Date(lastOperatorMessage.timestamp).getTime()) {
					lastOperatorMessage = message;
				}
			}

			if (message.body?.toLowerCase().includes("deseja voltar ao menu de setores")) {
				hasMenuPrompt = true;
			}
		}

		return {
			hasOperatorMessage,
			hasMenuPrompt,
			lastActivity,
			lastMessage,
			lastOperatorMessage,
			timeSinceLastActivity: Date.now() - lastActivity
		};
	}

	private async makeDecision(chat: any, session: ChatMonitoringSession, analysis: any, process: ProcessingLogger) {
		const { timeouts, autoFinishEnabled } = session;
		const { timeSinceLastActivity, hasOperatorMessage, hasMenuPrompt, lastMessage } = analysis;

		// Se a auto-finalização está desabilitada, apenas logga mas não finaliza
		if (!autoFinishEnabled) {
			if (timeSinceLastActivity >= timeouts.inactivity) {
				process.log("Chat inativo, mas auto-finalização está desabilitada", {
					timeSinceLastActivity: Math.round(timeSinceLastActivity / 1000 / 60) + " min"
				});
			}
			return;
		}

		// Caso 1: Chat sem nenhuma mensagem de operador
		if (!hasOperatorMessage) {
			if (timeSinceLastActivity >= timeouts.inactivity) {
				await this.finishChat(
					chat,
					"Atendimento finalizado pelo sistema devido inatividade do operador",
					process
				);
			}
			return;
		}

		// Caso 2: Menu já foi enviado
		if (hasMenuPrompt) {
			if (timeSinceLastActivity >= timeouts.menuResponse) {
				await this.finishChat(
					chat,
					"Atendimento finalizado automaticamente após tempo limite para resposta ao menu",
					process
				);
			}
			return;
		}

		// Caso 3: Chat inativo (independente de quem foi o último a responder)
		if (timeSinceLastActivity >= timeouts.inactivity) {
			// Se operador foi o último a responder, apenas notifica
			if (lastMessage?.from.startsWith("me:")) {
				process.log("Cliente inativo há muito tempo após resposta do operador");
				await messagesDistributionService.addSystemMessage(
					chat,
					`O cliente está aguardando há mais de ${Math.round(timeouts.inactivity / 1000 / 60)} minutos após sua última resposta. Deseja encerrar ou continuar o atendimento?`
				);
			} else {
				// Se cliente foi o último a responder, envia menu
				process.log("Enviando menu de opções devido à inatividade");
				await this.sendInactivityMenu(chat, process);
			}
		}
	}

	private async sendInactivityMenu(chat: any, process: ProcessingLogger) {
		const clientMessage = chat.messages.find(
			(m: any) => !m.from.startsWith("me:") && !m.from.startsWith("bot:") && !m.from.startsWith("system")
		);

		if (!clientMessage) {
			process.log("Nenhuma mensagem de cliente encontrada para envio do menu");
			return;
		}

		await whatsappService.sendBotMessage(clientMessage.from, {
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

		await prismaService.wppChat.update({
			where: { id: chat.id },
			data: { botId: 1 }
		});

		chooseSectorBot.forceStep(chat.id, 4, chat.userId ?? 0);

		// Atualiza sessão para indicar que menu foi enviado
		const session = this.chatSessions.get(chat.id);
		if (session) {
			session.hasMenuPrompt = true;
			session.state = "menu_sent";
			this.sessionStore.scheduleSave(() => this.chatSessions.values());
		}

		process.log("Menu de inatividade enviado e bot configurado");
	}

	public async createSchedule(token: string, session: SessionData, data: CreateScheduleDTO) {
		const chat = await prismaService.wppChat.findFirst({
			where: {
				contactId: data.contactId,
				instance: session.instance,
				isFinished: false
			}
		});

		const date = new Date(data.date);

		const schedules = await prismaService.wppSchedule.create({
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
			await chatsService.finishChatById(token, session, chat.id, -50);
			await messagesDistributionService.addSystemMessage(
				chat,
				"Retorno agendado para: " + date.toLocaleString(),
				true
			);
		}

		return schedules;
	}

	public async getAllSchedules() {
		const schedules = await prismaService.wppSchedule.findMany({
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

	public async editSchedule(scheduleData: WppSchedule, scheduleId: number) {
		const schedules = await prismaService.wppSchedule.update({
			where: { id: scheduleId },
			data: scheduleData
		});

		return schedules;
	}

	public async deleteSchedule(scheduleId: number) {
		const schedules = await prismaService.wppSchedule.delete({
			where: { id: scheduleId }
		});

		return schedules;
	}
}

export default new SchedulesService();
