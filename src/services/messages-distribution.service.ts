import {
	SocketEventType,
	SocketServerAdminRoom,
	SocketServerChatRoom,
	SocketServerMonitorRoom,
	SocketServerUserRoom,
	SocketServerWalletRoom,
	User,
	WppMessageEventData
} from "@in.pulse-crm/sdk";
import { Formatter, Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import {
	AutomaticResponseRule,
	AutomaticResponseSchedule,
	WppChat,
	WppContact,
	WppMessage,
	WppMessageStatus,
	WppSector
} from "@prisma/client";
import { InternalServerError } from "@rgranatodutra/http-errors";
import MessageFlow from "../message-flow/message-flow";
import MessageFlowFactory from "../message-flow/message-flow.factory";
import ProcessingLogger from "../utils/processing-logger";
import chatsService from "./chats.service";
import contactsService from "./contacts.service";
import messageQueueService from "./message-queue.service";
import messagesService from "./messages.service";
import prismaService from "./prisma.service";
import socketService from "./socket.service";
import whatsappService from "./whatsapp.service";
import botsRegistry from "../bots/bots-registry";


class MessagesDistributionService {
	private flows: Map<string, MessageFlow> = new Map();

	public async getFlow(instance: string, sectorId: number): Promise<MessageFlow> {
		const flowKey = `${instance}:${sectorId}`;
		const flow = this.flows.get(flowKey);

		if (!flow) {
			const newFlow = await MessageFlowFactory.createMessageFlow(instance, sectorId);

			this.flows.set(flowKey, newFlow);
			return newFlow;
		}

		return flow;
	}

	private async getSectors(clientId: number) {
		const client = await prismaService.wppClient.findUnique({
			where: { id: clientId },
			include: { sectors: true }
		});

		if (!client || !client.sectors || client.sectors.length === 0) {
			throw new Error("Setor não encontrado para esta instância.");
		}

		return client.sectors;
	}

	/**
	 * Processa bot ativo em um chat existente
	 */
	private async processBotMessage(chat: WppChat, contact: WppContact, msg: WppMessage, logger: ProcessingLogger) {
		logger.log(`Verificando se o chat tem bot ativo para processar a mensagem. Bot ID: ${chat.botId}`);
		if (!chat.botId) return;

		const botId = Number(chat.botId);
		if (!Number.isFinite(botId)) {
			logger.log(`Bot ID inválido para registry lookup: ${chat.botId}`);
			return;
		}

		const bot = botsRegistry.get(botId);
		if (!bot) {
			Logger.debug(`Bot ID ${botId} não encontrado no registry`, botsRegistry);
			logger.log(`Bot ID ${botId} não encontrado no registry`);
			return;
		}

		logger.log(`Processando mensagem com bot ID ${botId}`);
		await bot.processMessage(chat, contact, msg);
	}

	/**
	 * Inicializa bot em um novo chat
	 */
	private async initializeBotForNewChat(
		chat: WppChat,
		contact: WppContact,
		msg: WppMessage,
		logger: ProcessingLogger
	) {
		if (!chat.botId) return;

		const botId = Number(chat.botId);
		if (!Number.isFinite(botId)) {
			logger.log(`Bot ID inválido para inicialização: ${chat.botId}`);
			return;
		}

		const bot = botsRegistry.get(botId);
		if (!bot) {
			logger.log(`Bot ID ${botId} não encontrado no registry para inicialização`);
			return;
		}

		logger.log(`Inicializando bot ID ${botId} para novo chat`);

		// Se o bot tem método startBot, usa; caso contrário, usa processMessage
		if (bot.startBot) {
			await bot.startBot(chat, contact, msg.from, msg.id);
		} else {
			await bot.processMessage(chat, contact, msg);
		}
	}

	/**
	 * Determina qual bot deve ser ativado para um novo chat
	 */
	private async determineBotForNewChat(
		chat: WppChat,
		contact: WppContact,
		logger: ProcessingLogger
	): Promise<number | null> {
		// Verifica bots com método shouldActivate (ordem de prioridade)
		for (const [botId, bot] of botsRegistry.entries()) {
			if (!bot) {
				logger.log(`Bot ID ${botId} não está registrado corretamente (undefined)`);
				continue;
			}
			if (bot?.shouldActivate) {
				const shouldActivate = await bot.shouldActivate(chat, contact);
				if (shouldActivate) {
					logger.log(`Bot ID ${botId} será ativado (via shouldActivate)`);
					return Number(botId);
				}
			}
		}

		return null;
	}

	/**
	 * Cria um novo chat baseado na quantidade de setores
	 */
	public async createNewChat(
		instance: string,
		sectors: WppSector[],
		contact: WppContact,
		logger: ProcessingLogger,
		skipBotCheck: boolean = false
	): Promise<{ chat: WppChat; systemMessage: string | null }> {
		// Múltiplos setores: ativa bot de escolha de setor
		if (sectors.length > 1) {
			logger.log("Mais de um setor encontrado, iniciando o fluxo de escolha de setor.");
			const chat = await prismaService.wppChat.create({
				data: {
					instance,
					type: "RECEPTIVE",
					contactId: contact.id,
					sectorId: sectors[0]!.id,
					startedAt: new Date(),
					botId: 1
				}
			});
			await chatsService.syncChatToLocal(chat);
			return { chat, systemMessage: null };
		}

		// Fluxo padrão: verifica se deve ativar bot primeiro
		logger.log("Um setor encontrado, verificando ativação de bots.");

		// Cria chat temporário para verificar bots (sem persistir ainda)
		const tempChat = {
			instance,
			type: "RECEPTIVE" as const,
			contactId: contact.id,
			sectorId: sectors[0]!.id,
			startedAt: new Date()
		} as WppChat;

		// Verifica se algum bot deve ser ativado
		if (!skipBotCheck) {
			const botId = await this.determineBotForNewChat(tempChat, contact, logger);

			if (botId) {
				// Se tem bot, cria chat com o bot ativo (pode incluir userId se bot definir)
				logger.log(`Bot ID ${botId} será ativado. Criando chat com bot.`);
				const chatData: any = {
					instance,
					type: "RECEPTIVE",
					contactId: contact.id,
					sectorId: sectors[0]!.id,
					startedAt: new Date(),
					botId
				};

				// Bot Vollo (ID 4) tem tratamento especial: atribui userId=15 fixo
				if (botId === 4) {
					chatData.userId = 15;
					logger.log("Bot Vollo detectado. Atribuindo userId=15 (operador padrão Vollo).");
				}

				const chat = await prismaService.wppChat.create({
					data: chatData
				});
				await chatsService.syncChatToLocal(chat);
				return { chat, systemMessage: null };
			}
		}

		// Sem bot: usa MessageFlow normal (atribui atendente)
		logger.log("Nenhum bot ativo. Usando MessageFlow para atribuir atendente.");
		const flow = await this.getFlow(instance, sectors[0]!.id);
		const result = await flow.getChatPayload(logger, contact);
		const { systemMessage, ...chatData } = result;

		const chat = await prismaService.wppChat.create({
			data: {
				...chatData,
				startedAt: new Date()
			}
		});
		await chatsService.syncChatToLocal(chat);

		return { chat, systemMessage: systemMessage || null };
	}

	public async processMessage(instance: string, clientId: number, msg: WppMessage, contactName?: string | null) {
		const logger = new ProcessingLogger(instance, "message-distribution", `WppMessage-${msg.id}`, msg);

		try {
			// 1. Busca ou cria contato
			logger.log("Buscando contato para a mensagem.");
			const contact = await contactsService.getOrCreateContact(
				instance,
				contactName || Formatter.phone(msg.from),
				msg.from
			);
			logger.log("Contato encontrado!", contact);

			// 2. Busca chat existente
			logger.log("Buscando chat para o contato.");
			const currChat = await chatsService.getChatForContact(clientId, contact);
			await this.checkAndSendAutoResponseMessage(instance, contact, currChat, logger);

			// 3. Processa mensagem em chat existente
			if (currChat) {
				logger.log("Chat anterior encontrado para o contato.", currChat);
				await this.processBotMessage(currChat, contact, msg, logger);
				const outputMessage = await this.insertAndNotify(logger, currChat, msg);
				return outputMessage;
			}

			// 4. Cria novo chat
			logger.log("Nenhum chat encontrado para o contato.");
			const sectors = await this.getSectors(clientId);
			const { chat: newChat, systemMessage } = await this.createNewChat(instance, sectors, contact, logger);

			if (!newChat) {
				throw new Error("Nenhum chat foi criado.");
			}

			// 5. Inicializa bot se necessário
			await this.initializeBotForNewChat(newChat, contact, msg, logger);

			// 6. Finaliza criação do chat
			logger.log("Novo chat criado!", newChat);

			const avatarUrl = await whatsappService.getProfilePictureUrl(instance, msg.from);
			if (avatarUrl) {
				const updatedChat = await prismaService.wppChat.update({
					data: { avatarUrl },
					where: { id: newChat.id }
				});
				await chatsService.syncChatToLocal(updatedChat);
			}

			const finalSystemMessage = systemMessage || "Atendimento iniciado pelo cliente!";
			await this.addSystemMessage(newChat, finalSystemMessage, true);
			logger.log("Chat criado com sucesso!", newChat);

			const outputMsg = await this.insertAndNotify(logger, newChat, msg, true);
			return outputMsg;
		} catch (err) {
			const msg = sanitizeErrorMessage(err);
			logger.log(`Erro ao processar mensagem: ${msg}`);
			logger.failed(err);
			if (err instanceof InternalServerError) {
				throw err;
			}
			throw new InternalServerError(`Não foi possível processar a mensagem. Detalhes: ${msg}`, err as Error);
		}
	}

	/**
	 * Método chamado pela fila de processamento para processar uma mensagem
	 * Este método é injetado no messageQueueService através do setProcessHandler
	 */
	public async processMessageFromQueue(
		instance: string,
		clientId: number,
		messageId: number,
		contactName?: string | null
	): Promise<void> {
		// Busca a mensagem completa
		const message = await prismaService.wppMessage.findUnique({
			where: { id: messageId }
		});

		if (!message) {
			throw new Error(`Mensagem ${messageId} não encontrada no banco de dados`);
		}

		// Processa a mensagem normalmente
		await this.processMessage(instance, clientId, message, contactName);
	}

	public async transferChatSector(sector: WppSector, contact: WppContact, chat: WppChat) {
		const logger = new ProcessingLogger(
			sector.instance,
			"transfer-chat-sector",
			`WppChat-${chat.id}_${Date.now()}`,
			{ sector, contact, chat }
		);

		try {
			const flow = await this.getFlow(sector.instance, sector.id);
			const data = await flow.getChatPayload(logger, contact);
			const updatedChat = await prismaService.wppChat.update({
				where: { id: chat.id },
				data: { ...data, botId: null }
			});
			await chatsService.syncChatToLocal(updatedChat);

			await this.addSystemMessage(updatedChat, `Transferido para o setor ${sector.name}!`);

			await this.notifyChatStarted(logger, updatedChat);
			logger.success(updatedChat);
		} catch (err) {
			logger.log(`Erro ao processar mensagem!`);
			logger.failed(err);
		}
	}

	public async transferChatOperator(sector: WppSector, operador: User, contact: WppContact, chat: WppChat) {
		const logger = new ProcessingLogger(
			sector.instance,
			"transfer-chat-operator",
			`WppChat-${chat.id}_${Date.now()}`,
			{ sector, contact, chat }
		);

		try {
			const flow = await this.getFlow(sector.instance, sector.id);
			const data = await flow.getChatPayload(logger, contact);

			const updatedChat = await prismaService.wppChat.update({
				where: { id: chat.id },
				data: { ...data, userId: operador.CODIGO, botId: null }
			});
			await chatsService.syncChatToLocal(updatedChat);

			await this.addSystemMessage(updatedChat, `Transferido para o setor ${sector.name}!`);

			await this.notifyChatStarted(logger, updatedChat);
			logger.success(updatedChat);
		} catch (err) {
			logger.log(`Erro ao processar mensagem!`);
			logger.failed(err);
		}
	}
	public async notifyChatStarted(process: ProcessingLogger, chat: WppChat) {
		try {
			const data = { chatId: chat.id };
			const monitorRoom: SocketServerMonitorRoom = `${chat.instance}:${chat.sectorId!}:monitor`;

			await socketService.emit(SocketEventType.WppChatStarted, monitorRoom, data);

			process.log(`Chat enviado para o socket: /${monitorRoom}/ room!`);

			if (chat.walletId) {
				const walletRoom: SocketServerWalletRoom = `${chat.instance}:wallet:${chat.walletId}`;
				await socketService.emit(SocketEventType.WppChatStarted, walletRoom, data);
				process.log(`Chat enviado para o socket: /${walletRoom}/ room!`);
			}

			if (chat.userId === -1) {
				const adminRoom: SocketServerAdminRoom = `${chat.instance}:${chat.sectorId!}:admin`;
				await socketService.emit(SocketEventType.WppChatStarted, adminRoom, data);
				process.log(`Chat enviado para o socket: /${adminRoom}/ room!`);
			}

			if (chat.userId) {
				const userRoom: SocketServerUserRoom = `${chat.instance}:user:${chat.userId}`;
				await socketService.emit(SocketEventType.WppChatStarted, userRoom, data);
				process.log(`Chat enviado para o socket: /${userRoom}/ room!`);
			}
		} catch (err) {
			const msg = sanitizeErrorMessage(err);
			process.log(`Erro ao enviar o chat para o socket: ${msg}`);
			throw err;
		}
	}

	public async notifyMessage(process: ProcessingLogger | null, message: WppMessage) {
		try {
			process?.log("Transmitindo mensagem via socket.");
			const instance = message.instance;

			if (message.chatId === null) {
				process?.log("Mensagem não possui chatId.");
				return;
			}

			const room: SocketServerChatRoom = `${instance}:chat:${message.chatId}`;
			const data: WppMessageEventData = { message };
			await socketService.emit(SocketEventType.WppMessage, room, data);
			process?.log(`Mensagem transmitida para a sala: /${room}/ room!`);
		} catch (err) {
			const msg = sanitizeErrorMessage(err);
			process?.log(`Falha ao transmitir mensagem: ${msg}`);
			throw err;
		}
	}

	private async insertMessageOnChat(logger: ProcessingLogger, message: WppMessage, chat: WppChat) {
		try {
			const insertedMessage = await prismaService.wppMessage.update({
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
		} catch (err) {
			const msg = sanitizeErrorMessage(err);
			logger.log(`Erro ao inserir a mensagem no chat: ${msg}`);
			throw err;
		}
	}

	public async insertAndNotify(logger: ProcessingLogger, chat: WppChat, msg: WppMessage, isChatNew: boolean = false) {
		const insertedMsg = await this.insertMessageOnChat(logger, msg, chat);
		if (isChatNew) {
			await this.notifyChatStarted(logger, chat);
		}
		await this.notifyMessage(logger, insertedMsg);

		if (isChatNew || chat.botId === 2) {
			logger.success(insertedMsg);
		}

		return insertedMsg;
	}

	public async processMessageStatus(type: "wwebjs" | "waba", id: string, status: WppMessageStatus) {
		try {
			const message = await prismaService.wppMessage.update({
				where: {
					[(type + "Id") as "wwebjsId"]: id
				},
				data: {
					status
				}
			});

			if (message.chatId === null) {
				return;
			}

			const chatRoom: SocketServerChatRoom = `${message.instance}:chat:${message.chatId}`;
			socketService.emit(SocketEventType.WppMessageStatus, chatRoom, {
				messageId: message.id,
				contactId: message.contactId!,
				status
			});
		} catch (err) {
			console.log("Não foi possível atualizar a mensagem de id: " + id);
		}
	}

	public async processMessageStatusGS(gs_id: string, id: string, status: WppMessageStatus) {
		const logger = new ProcessingLogger("", "gs-message-status", `gs:${gs_id}`, { gs_id, meta_msg_id: id, status });

		try {
			logger.log("Iniciando atualização de status Gupshup/META", { gs_id, meta_msg_id: id, status });

			const findMsg = await prismaService.wppMessage.findFirst({
				where: {
					OR: [{ gupshupId: gs_id }, { wabaId: id }]
				}
			});

			if (!findMsg) {
				logger.log("Mensagem não encontrada para atualizar status", { triedKeys: [gs_id, id] });
				return;
			}

			logger.log("Mensagem localizada para atualização", {
				dbId: findMsg.id,
				prevStatus: findMsg.status,
				hasChat: findMsg.chatId !== null
			});

			const updatedMsg = await prismaService.wppMessage.update({
				where: {
					id: findMsg.id
				},
				data: {
					status,
					wabaId: id,
					gupshupId: gs_id
				}
			});

			logger.log("Status da mensagem atualizado", {
				dbId: updatedMsg.id,
				newStatus: updatedMsg.status,
				chatId: updatedMsg.chatId
			});

			if (updatedMsg.chatId === null) {
				logger.log("Mensagem sem chat associado após update. Encerrando fluxo.");
				logger.success("Processo concluído (sem socket emit).");
				return;
			}

			const chatRoom: SocketServerChatRoom = `${updatedMsg.instance}:chat:${updatedMsg.chatId}`;
			socketService.emit(SocketEventType.WppMessageStatus, chatRoom, {
				messageId: updatedMsg.id,
				contactId: updatedMsg.contactId!,
				status
			});

			logger.log("Status emitido via socket", { room: chatRoom });
			logger.success("Atualização de status concluída com sucesso");
		} catch (err) {
			logger.log("Falha ao atualizar status da mensagem", { error: (err as any)?.message });
			logger.failed(err);
		}
	}

	/**
	 * Processa eventos de edição de mensagem do WhatsApp
	 * @param type - Tipo do cliente WhatsApp ('wwebjs' ou 'waba')
	 * @param id - ID da mensagem no sistema correspondente
	 * @param newBody - Novo conteúdo da mensagem editada
	 * @returns A mensagem atualizada ou undefined se não encontrada
	 */
	public async processMessageEdit(type: "wwebjs" | "waba", id: string, newBody: string) {
		const logger = new ProcessingLogger("", "message-edit", `${type}-${id}`, { id, newBody });

		try {
			logger.log("Processando edição de mensagem.");

			// Busca a mensagem original
			const originalMessage = await prismaService.wppMessage.findUnique({
				where: {
					[(type + "Id") as "wwebjsId"]: id
				},
				include: {
					WppChat: true,
					WppContact: true
				}
			});

			if (!originalMessage) {
				logger.log("Mensagem original não encontrada.");
				return;
			}

			logger.log("Mensagem original encontrada.", originalMessage);

			// Atualiza a mensagem com o novo conteúdo e marca como editada
			const updatedMessage = await prismaService.wppMessage.update({
				where: {
					[(type + "Id") as "wwebjsId"]: id
				},
				data: {
					body: newBody,
					isEdited: true
				}
			});

			logger.log("Mensagem atualizada com sucesso.", updatedMessage);

			// Se a mensagem pertence a um chat, notifica via socket
			if (updatedMessage.chatId) {
				const chatRoom: SocketServerChatRoom = `${updatedMessage.instance}:chat:${updatedMessage.chatId}`;

				await socketService.emit(SocketEventType.WppMessageEdit, chatRoom, {
					messageId: updatedMessage.id,
					contactId: updatedMessage.contactId || 0,
					newText: updatedMessage.body
				});

				logger.log(`Edição da mensagem notificada para a sala: /${chatRoom}/`);
			}

			logger.success(updatedMessage);
			return updatedMessage;
		} catch (err) {
			const msg = sanitizeErrorMessage(err);
			logger.log(`Erro ao processar edição da mensagem: ${msg}`);
			logger.failed(err);
			throw err;
		}
	}

	public async addSystemMessage(chat: WppChat, text: string, notify: boolean = true) {
		const now = new Date();
		const message = await messagesService.insertMessage({
			body: text,
			from: "system",
			to: "system",
			instance: chat.instance,
			status: "RECEIVED",
			timestamp: now.getTime().toString(),
			sentAt: now,
			type: "chat",
			chatId: chat.id,
			contactId: chat.contactId,
			clientId: null
		});

		if (notify) {
			const chatRoom: SocketServerChatRoom = `${chat.instance}:chat:${chat.id}`;
			socketService.emit(SocketEventType.WppMessage, chatRoom, {
				message
			});
		}
	}

	public async addThirdpartyMessage(
		instance: string,
		text: string,
		origin: string,
		notify: boolean = true,
		contact: WppContact,
		chat?: WppChat | null,
		quoteMessageId?: number
	) {
		const now = new Date();

		const message = await messagesService.insertMessage({
			body: text,
			from: `thirdparty:${origin}`,
			to: "system",
			instance,
			status: "RECEIVED",
			timestamp: now.getTime().toString(),
			sentAt: now,
			type: "error",
			chatId: chat?.id || null,
			contactId: contact.id,
			quotedId: quoteMessageId || null,
			clientId: null
		});

		if (notify && chat) {
			const chatRoom: SocketServerChatRoom = `${instance}:chat:${chat.id}`;
			socketService.emit(SocketEventType.WppMessage, chatRoom, {
				message
			});
		}
	}

	private async checkAndSendAutoResponseMessage(
		instance: string,
		contact: WppContact,
		currChat: WppChat | null,
		logger: ProcessingLogger
	) {
		try {
			type RuleWithIncludes = AutomaticResponseRule & { schedules: AutomaticResponseSchedule[] };

			logger.log("[AutoResponse] Iniciando avaliação de regras", {
				instance,
				contactId: contact.id,
				chatId: currChat?.id || null,
				chatUserId: currChat?.userId || null,
				chatSectorId: currChat?.sectorId || null
			});

			// 1) Carrega TODAS as regras potencialmente aplicáveis (globais + específicas do user do chat)
			const rules: RuleWithIncludes[] = await prismaService.automaticResponseRule.findMany({
				where: {
					instance,
					isEnabled: true,
					OR: [{ isGlobal: true }, { userAssignments: { some: { userId: currChat?.userId ?? -1 } } }]
				},
				include: { schedules: true },
				orderBy: [{ id: "desc" }]
			});

			logger.log("[AutoResponse] Regras candidatas carregadas", { totalRules: rules.length });

			if (!rules.length) return;

			const toLocalInTZ = (d: Date, tz: string) => {
				const fmt = new Intl.DateTimeFormat("en-CA", {
					timeZone: tz,
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					hour12: false
				});
				const parts = fmt.formatToParts(d);
				const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
				const y = Number(get("year"));
				const m = Number(get("month"));
				const da = Number(get("day"));
				const h = Number(get("hour"));
				const mi = Number(get("minute"));
				return new Date(Date.UTC(y, m - 1, da, h, mi, 0, 0));
			};

			const parseHHmm = (s: string) => {
				const [hh = 0, mm = 0] = s.split(":").map(Number);

				return hh * 60 + mm;
			};

			const minutesOfDay = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();

			const lastDayOfMonth = (y: number, m1_12: number) => {
				return new Date(Date.UTC(y, m1_12, 0)).getUTCDate();
			};

			const inDateWindow = (nowLocal: Date, startDate?: Date | null, endDate?: Date | null) => {
				if (startDate && nowLocal < startDate) return false;
				if (endDate && nowLocal > endDate) return false;
				return true;
			};

			const inTimeWindow = (nowLocal: Date, startTime: string, endTime: string) => {
				const nowMin = minutesOfDay(nowLocal);
				const s = parseHHmm(startTime);
				const e = parseHHmm(endTime);
				if (s <= e) return nowMin >= s && nowMin <= e;
				return nowMin >= s || nowMin <= e;
			};

			const scheduleMatchesNow = (sched: AutomaticResponseSchedule, now: Date) => {
				const tz = sched.timezone || "America/Fortaleza";
				const nowLocal = toLocalInTZ(now, tz);

				if (!sched.startTime || !sched.endTime) return false;

				const sDate = sched.startDate ? toLocalInTZ(sched.startDate, tz) : null;
				const eDate = sched.endDate ? toLocalInTZ(sched.endDate, tz) : null;
				if (!inDateWindow(nowLocal, sDate, eDate)) return false;

				if (!inTimeWindow(nowLocal, sched.startTime, sched.endTime)) return false;

				const y = nowLocal.getUTCFullYear();
				const m = nowLocal.getUTCMonth() + 1;
				const d = nowLocal.getUTCDate();
				const wd = nowLocal.getUTCDay();
				const freq = (sched.frequency as any) || "WEEKLY";

				if (freq === "DAILY") return true;

				if (freq === "WEEKLY") {
					const jsonDays = sched.daysOfWeek as unknown as number[] | null | undefined;
					if (jsonDays && jsonDays.length) return jsonDays.includes(wd);
					if (sched.dayOfWeek !== null && sched.dayOfWeek !== undefined) return wd === sched.dayOfWeek;
					return false;
				}

				if (freq === "MONTHLY") {
					if (!sched.dayOfMonth) return false;
					const lastDM = lastDayOfMonth(y, m);
					const eff = Math.min(sched.dayOfMonth, lastDM);
					return d === eff;
				}

				if (freq === "YEARLY") {
					if (!sched.dayOfMonth || !sched.month) return false;
					if (m !== sched.month) return false;
					const lastDM = lastDayOfMonth(y, m);
					const eff = Math.min(sched.dayOfMonth, lastDM);
					return d === eff;
				}

				if (freq === "ONCE") {
					return !!sched.startDate;
				}

				return false;
			};

			// 2) Filtra as regras que possuem ALGUM schedule ativo agora, e escolhe o schedule que bateu
			const now = new Date();
			type Applicable = {
				rule: RuleWithIncludes;
				schedule: AutomaticResponseSchedule;
				windowMinutes: number; // usado para decidir empates (preferimos a janela mais "estreita")
			};
			const applicable: Applicable[] = [];

			for (const r of rules) {
				const activeSched = r.schedules.find((s) => scheduleMatchesNow(s, now));
				if (!activeSched) continue;

				// calcula o tamanho da janela (em minutos) para critério de especificidade
				const sMin = parseHHmm(activeSched.startTime);
				const eMin = parseHHmm(activeSched.endTime);
				let width = eMin - sMin;
				if (width < 0) width += 24 * 60; // cruza meia-noite

				applicable.push({ rule: r, schedule: activeSched, windowMinutes: width });
			}

			if (!applicable.length) {
				logger.log("[AutoResponse] Nenhuma regra ativa no momento.", { contactId: contact.id });
				return;
			}

			logger.log("[AutoResponse] Regras ativas encontradas", { totalActiveRules: applicable.length });

			// 3) Resolução de choque:
			//    - Se existir qualquer GLOBAL aplicável, considera APENAS as globais.
			//    - Caso contrário, segue com as específicas do usuário.
			const hasGlobal = applicable.some((x) => x.rule.isGlobal);
			let chosenPool = hasGlobal
				? applicable.filter((x) => x.rule.isGlobal)
				: applicable.filter((x) => !x.rule.isGlobal);

			// 4) Se ainda restarem múltiplas, escolhemos APENAS UMA para não spammar:
			//    - 1º: menor janela (mais específica)
			//    - 2º: mais recente (id DESC já veio da consulta, mas reforçamos)
			chosenPool.sort((a, b) => {
				if (a.windowMinutes !== b.windowMinutes) return a.windowMinutes - b.windowMinutes;
				return b.rule.id - a.rule.id;
			});

			const chosen = chosenPool[0]!;
			const ruleToApply = chosen.rule;

			logger.log(`[AutoResponse] Regra selecionada: "${ruleToApply.name}" (global=${ruleToApply.isGlobal})`, {
				ruleId: ruleToApply.id,
				windowMinutes: chosen.windowMinutes,
				chatId: currChat?.id || null
			});

			// 5) Flood-guard rápido global (30s): evita duplicidade acidental
			const FLOOD_SECONDS = 30;
			if (contact.lastOutOfHoursReplySentAt) {
				const secs = (now.getTime() - new Date(contact.lastOutOfHoursReplySentAt).getTime()) / 1000;
				if (secs < FLOOD_SECONDS) {
					logger.log(`[AutoResponse] Flood-guard global ativo (${FLOOD_SECONDS}s). Pulando envio.`, {
						secondsSinceLastReply: secs,
						contactId: contact.id
					});
					return;
				}
			}

			// 6) Cooldown por-regra (via billingCategory = AUTO_REPLY_RULE:<id>)
			const billingCategory = `AUTO_REPLY_RULE:${ruleToApply.id}`;
			const lastByRule = await prismaService.wppMessage.findFirst({
				where: {
					contactId: contact.id,
					from: "system:auto-reply",
					billingCategory
				},
				orderBy: { sentAt: "desc" }
			});

			if (lastByRule) {
				const secs = (now.getTime() - new Date(lastByRule.sentAt).getTime()) / 1000;
				if (secs < ruleToApply.cooldownSeconds) {
					logger.log(`[AutoResponse] Cooldown por-regra ativo (ruleId=${ruleToApply.id}). Pulando envio.`, {
						secondsSinceLastRuleReply: secs,
						cooldownSeconds: ruleToApply.cooldownSeconds
					});
					return;
				}
			}

			const sector = await prismaService.wppSector.findUnique({
				where: { id: currChat?.sectorId || -1 }
			});

			if (!sector) {
				logger.log("[AutoResponse] Setor não encontrado para envio de resposta automática. Pulando envio.", {
					contactId: contact.id,
					chatId: currChat?.id || null,
					sectorId: currChat?.sectorId || null
				});
				return;
			}

			logger.log("[AutoResponse] Enviando resposta automática", {
				ruleId: ruleToApply.id,
				contactId: contact.id,
				phone: contact.phone,
				sectorId: sector.id,
				hasFile: !!ruleToApply.fileId
			});

			// 7) Envia e atualiza "último envio"
			const sentAutoReply = await whatsappService.sendAutoReplyMessage(
				instance,
				sector,
				contact.phone,
				ruleToApply.message,
				ruleToApply.fileId
			);

			if (!sentAutoReply) {
				logger.log("[AutoResponse] Falha no envio da resposta automática. lastOutOfHoursReplySentAt não será atualizado.", {
					ruleId: ruleToApply.id,
					contactId: contact.id
				});
				return;
			}

			await prismaService.wppContact.update({
				where: { id: contact.id },
				data: { lastOutOfHoursReplySentAt: new Date() }
			});

			logger.log("[AutoResponse] Resposta automática enviada e controle de envio atualizado", {
				ruleId: ruleToApply.id,
				contactId: contact.id,
				autoReplyMessageId: sentAutoReply.id
			});
		} catch (err) {
			logger.log("[AutoResponse] Erro ao avaliar/enviar resposta automática", {
				instance,
				contactId: contact.id,
				chatId: currChat?.id || null,
				error: sanitizeErrorMessage(err)
			});
		}
	}
}

const messagesDistributionServiceInstance = new MessagesDistributionService();

// Configura o handler de processamento da fila após a instância ser criada
messageQueueService.setProcessHandler({
	processMessage: messagesDistributionServiceInstance.processMessageFromQueue.bind(messagesDistributionServiceInstance)
});

export default messagesDistributionServiceInstance;
