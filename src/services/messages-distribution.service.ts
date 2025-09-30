import {
	AutomaticResponseRule,
	AutomaticResponseSchedule,
	WppChat,
	WppContact,
	WppMessage,
	WppMessageStatus,
	WppSector
} from "@prisma/client";
import MessageFlow from "../message-flow/message-flow";
import MessageFlowFactory from "../message-flow/message-flow.factory";
import prismaService from "./prisma.service";
import contactsService from "./contacts.service";
import { Formatter, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import ProcessingLogger from "../utils/processing-logger";
import socketService from "./socket.service";
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
import chatsService from "./chats.service";
import messagesService from "./messages.service";
import whatsappService from "./whatsapp.service";
import chooseSectorBot from "../bots/choose-sector.bot";
import chooseSellerBot from "../bots/seller-vollo.bot";
import exatronSatisfactionBot from "../bots/exatron-satisfaction.bot";
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
		const sectors = await prismaService.wppSector.findMany({
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

	public async processMessage(instance: string, clientId: number, msg: WppMessage) {
		const logger = new ProcessingLogger(instance, "message-distribution", `WppMessage-${msg.id}`, msg);

		try {
			logger.log("Buscando contato para a mensagem.");
			const contact = await contactsService.getOrCreateContact(instance, Formatter.phone(msg.from), msg.from);
			logger.log("Contato encontrado!", contact);

			logger.log("Buscando chat para o contato.");
			const currChat = await chatsService.getChatForContact(clientId, contact);
			await this.checkAndSendAutoResponseMessage(instance, contact, currChat, logger);

			if (currChat) {
				logger.log("Chat anterior encontrado para o contato.", currChat);
				await this.insertAndNotify(logger, currChat, msg);

				if (currChat.botId === 1) {
					if (currChat.instance === "vollo") {
						await chooseSellerBot.processMessage(currChat, contact, msg);
					} else {
						await chooseSectorBot.processMessage(currChat, contact, msg);
					}
				}

				if (currChat.botId === 2) {
					await exatronSatisfactionBot.processMessage(currChat, contact, msg);
				}
				return;
			}

			let newChat: WppChat | null = null;

			logger.log("Nenhum chat encontrado para o contato.");

			const sectors = await this.getSectors(clientId);
			if (sectors.length > 1) {
				logger.log("Mais de um setor encontrado, iniciando o fluxo de escolha de setor.");
				newChat = await prismaService.wppChat.create({
					data: {
						instance,
						type: "RECEPTIVE",
						contactId: contact.id,
						sectorId: sectors[0]!.id,
						startedAt: new Date(),
						botId: 1
					}
				});
			} else {
				logger.log("Um setor encontrado, iniciando o fluxo de atendimento.");
				const flow = await this.getFlow(instance, sectors[0]!.id);
				const data = await flow.getChatPayload(logger, contact);
				newChat = await prismaService.wppChat.create({
					data: {
						...data,
						botId: instance === "vollo" ? 1 : null,
						...(instance === "vollo" && { userId: 15 })
					}
				});
			}

			if (!newChat) {
				throw new Error("Nenhum chat foi criado.");
			}

			if (newChat.botId === 1) {
				if (newChat.instance === "vollo") {
					await chooseSellerBot.processMessage(newChat, contact, msg);
				} else {
					await chooseSectorBot.processMessage(newChat, contact, msg);
				}
			}

			logger.log("Novo chat encontrado!", newChat);

			logger.log("Buscando foto de perfil do cliente.");
			const avatarUrl = await whatsappService.getProfilePictureUrl(instance, msg.from);
			if (avatarUrl) {
				await prismaService.wppChat.update({
					data: { avatarUrl },
					where: { id: newChat.id }
				});
			}

			await this.addSystemMessage(newChat, "Atendimento iniciado pelo cliente!", true);
			logger.log("Chat criado com sucesso!", newChat);

			await this.insertAndNotify(logger, newChat, msg, true);
		} catch (err) {
			console.error(err);
			logger.log(`Erro ao processar mensagem!`);
			logger.failed(err);
		}
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

			await this.addSystemMessage(updatedChat, `Transferido para o setor ${sector.name}!`);

			await this.notifyChatStarted(logger, updatedChat);
			logger.success(updatedChat);
		} catch (err) {
			console.error(err);
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

			await this.addSystemMessage(updatedChat, `Transferido para o setor ${sector.name}!`);

			await this.notifyChatStarted(logger, updatedChat);
			logger.success(updatedChat);
		} catch (err) {
			console.error(err);
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

	private async insertAndNotify(
		logger: ProcessingLogger,
		chat: WppChat,
		msg: WppMessage,
		isChatNew: boolean = false
	) {
		const insertedMsg = await this.insertMessageOnChat(logger, msg, chat);
		if (isChatNew) {
			await this.notifyChatStarted(logger, chat);
		}
		await this.notifyMessage(logger, insertedMsg);
		logger.success(insertedMsg);
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
		try {
			const findMsg = await prismaService.wppMessage.findFirst({
				where: {
					OR: [
						{ gupshupId: gs_id },
						{ wabaId: gs_id }
					]
				}
			});

			if (!findMsg) {
				console.log("Mensagem não encontrada para atualizar o status, gs_id: " + gs_id);
				return;
			}

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

			if (updatedMsg.chatId === null) {
				return;
			}

			const chatRoom: SocketServerChatRoom = `${updatedMsg.instance}:chat:${updatedMsg.chatId}`;
			socketService.emit(SocketEventType.WppMessageStatus, chatRoom, {
				messageId: updatedMsg.id,
				contactId: updatedMsg.contactId!,
				status
			});
		} catch (err) {
			console.log("Não foi possível atualizar a mensagem de id: " + id);
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
			contactId: chat.contactId
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
			quotedId: quoteMessageId || null
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
  type RuleWithIncludes =
    AutomaticResponseRule & { schedules: AutomaticResponseSchedule[] };

  // 1) Carrega TODAS as regras potencialmente aplicáveis (globais + específicas do user do chat)
  const rules: RuleWithIncludes[] = await prismaService.automaticResponseRule.findMany({
    where: {
      instance,
      isEnabled: true,
      OR: [
        { isGlobal: true },
        { userAssignments: { some: { userId: currChat?.userId ?? -1 } } }
      ]
    },
    include: { schedules: true },
    orderBy: [{ id: 'desc' }]
  });

  if (!rules.length) return;

  const toLocalInTZ = (d: Date, tz: string) => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = fmt.formatToParts(d);
    const get = (t: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === t)?.value ?? '';
    const y = Number(get('year'));
    const m = Number(get('month'));
    const da = Number(get('day'));
    const h = Number(get('hour'));
    const mi = Number(get('minute'));
    return new Date(Date.UTC(y, m - 1, da, h, mi, 0, 0));
  };

const parseHHmm = (s: string) => {
  const [hh = 0, mm = 0] = s.split(':').map(Number);

  return (hh * 60) + mm;
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
    if (s <= e) return (nowMin >= s && nowMin <= e);
    return (nowMin >= s || nowMin <= e);
  };

  const scheduleMatchesNow = (sched: AutomaticResponseSchedule, now: Date) => {
    const tz = sched.timezone || 'America/Fortaleza';
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
    const freq = (sched.frequency as any) || 'WEEKLY';

    if (freq === 'DAILY') return true;

    if (freq === 'WEEKLY') {
      const jsonDays = (sched.daysOfWeek as unknown) as number[] | null | undefined;
      if (jsonDays && jsonDays.length) return jsonDays.includes(wd);
      if (sched.dayOfWeek !== null && sched.dayOfWeek !== undefined) return wd === sched.dayOfWeek;
      return false;
    }

    if (freq === 'MONTHLY') {
      if (!sched.dayOfMonth) return false;
      const lastDM = lastDayOfMonth(y, m);
      const eff = Math.min(sched.dayOfMonth, lastDM);
      return d === eff;
    }

    if (freq === 'YEARLY') {
      if (!sched.dayOfMonth || !sched.month) return false;
      if (m !== sched.month) return false;
      const lastDM = lastDayOfMonth(y, m);
      const eff = Math.min(sched.dayOfMonth, lastDM);
      return d === eff;
    }

    if (freq === 'ONCE') {
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
    const activeSched = r.schedules.find(s => scheduleMatchesNow(s, now));
    if (!activeSched) continue;

    // calcula o tamanho da janela (em minutos) para critério de especificidade
    const sMin = parseHHmm(activeSched.startTime);
    const eMin = parseHHmm(activeSched.endTime);
    let width = eMin - sMin;
    if (width < 0) width += 24 * 60; // cruza meia-noite

    applicable.push({ rule: r, schedule: activeSched, windowMinutes: width });
  }

  if (!applicable.length) {
    logger.log("[AutoResponse] Nenhuma regra ativa no momento.");
    return;
  }

  // 3) Resolução de choque:
  //    - Se existir qualquer GLOBAL aplicável, considera APENAS as globais.
  //    - Caso contrário, segue com as específicas do usuário.
  const hasGlobal = applicable.some(x => x.rule.isGlobal);
  let chosenPool = hasGlobal ? applicable.filter(x => x.rule.isGlobal) : applicable.filter(x => !x.rule.isGlobal);

  // 4) Se ainda restarem múltiplas, escolhemos APENAS UMA para não spammar:
  //    - 1º: menor janela (mais específica)
  //    - 2º: mais recente (id DESC já veio da consulta, mas reforçamos)
  chosenPool.sort((a, b) => {
    if (a.windowMinutes !== b.windowMinutes) return a.windowMinutes - b.windowMinutes;
    return b.rule.id - a.rule.id;
  });

  const chosen = chosenPool[0]!;
  const ruleToApply = chosen.rule;

  logger.log(`[AutoResponse] Regra selecionada: "${ruleToApply.name}" (global=${ruleToApply.isGlobal})`);

  // 5) Flood-guard rápido global (30s): evita duplicidade acidental
  const FLOOD_SECONDS = 30;
  if (contact.lastOutOfHoursReplySentAt) {
    const secs = (now.getTime() - new Date(contact.lastOutOfHoursReplySentAt).getTime()) / 1000;
    if (secs < FLOOD_SECONDS) {
      logger.log(`[AutoResponse] Flood-guard global ativo (${FLOOD_SECONDS}s). Pulando envio.`);
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
    orderBy: { sentAt: 'desc' }
  });

  if (lastByRule) {
    const secs = (now.getTime() - new Date(lastByRule.sentAt).getTime()) / 1000;
    if (secs < ruleToApply.cooldownSeconds) {
      logger.log(`[AutoResponse] Cooldown por-regra ativo (ruleId=${ruleToApply.id}). Pulando envio.`);
      return;
    }
  }

  // 7) Envia e atualiza "último envio"
  await whatsappService.sendAutoReplyMessage(
    instance,
    contact.phone,
    ruleToApply.message,
    ruleToApply.fileId,
  );

  await prismaService.wppContact.update({
    where: { id: contact.id },
    data: { lastOutOfHoursReplySentAt: new Date() }
  });
}

}

export default new MessagesDistributionService();
