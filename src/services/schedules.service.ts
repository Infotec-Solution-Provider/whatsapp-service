import { Prisma, WppContact, WppSchedule } from "@prisma/client";
import prismaService from "./prisma.service";
import {
	CreateScheduleDTO,
	Customer,
	SessionData,
	SocketEventType
} from "@in.pulse-crm/sdk";
import chatsService, { FETCH_CUSTOMERS_QUERY } from "./chats.service";
import messagesDistributionService from "./messages-distribution.service";
import cron from "node-cron";
import socketService from "./socket.service";
import { Logger } from "@in.pulse-crm/utils";
import whatsappService from "./whatsapp.service";
import chooseSectorBot from "../bots/choose-sector.bot";
import instancesService from "./instances.service";

interface ChatsFilters {
	userId?: string;
	sectorId?: string;
}
class SchedulesService {
	constructor() {
		cron.schedule("*/5 * * * *", async () => {
			this.runSchedulesJob();
			this.finishChatRoutine();
		});
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

	public async getSchedulesBySession(
		session: SessionData,
		filters: ChatsFilters
	) {
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
			? await instancesService.executeQuery<Array<Customer>>(
					session.instance,
					FETCH_CUSTOMERS_QUERY,
					[customerIds]
				)
			: [];

		for (const schedule of schedules) {
			const { contact, ...s } = schedule;

			let customer: Customer | null = null;

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

	public async finishChatRoutine() {
		const agora = new Date();
		const trintaMinAtras = new Date(agora.getTime() - 30 * 60 * 1000);
		const duasHorasAtras = new Date(agora.getTime() - 48 * 60 * 60 * 1000);

		// Busca os chats ativos iniciados há mais de 30 minutos e menos de 2 horas
		const chats = await prismaService.wppChat.findMany({
			where: {
				instance: "nunes",
				isFinished: false,
				startedAt: {
					gte: duasHorasAtras, // não mais antigo que 2h
					lte: trintaMinAtras // não mais recente que 30min
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

		Logger.debug(`[CRON] Verificando chats inativos...`);
		Logger.debug(`[CRON] Chats encontrados: ${chats.length}`);
		Logger.debug(`[CRON] Chats encontrados: ${JSON.stringify(chats)}`);

		for (const chat of chats) {
			// Verifica se existe mensagem enviada pelo operador
			const teveMensagemDeOperador = chat.messages.some((msg) =>
				msg.from.startsWith("me:")
			);
			Logger.debug(
				`[CRON] Chat ${chat.id} - Teve mensagem de operador: ${teveMensagemDeOperador}`
			);
			if (!teveMensagemDeOperador) {
				await prismaService.wppChat.update({
					where: { id: chat.id },
					data: {
						isFinished: true,
						finishedAt: new Date(),
						finishedBy: null // ou ID do sistema
					}
				});
				Logger.debug(
					`[CRON] Chat ${chat.id} finalizado automaticamente.`
				);

				const event = SocketEventType.WppChatFinished;

				let finishMsg: string = `Atendimento finalizado pelo sistema devido inatividade do operador.`;
				Logger.debug("Mensagem de finalização:", finishMsg);
				await messagesDistributionService.addSystemMessage(
					chat,
					finishMsg
				);
				await socketService.emit(event, `${chat.instance}:chat:${chat.id}`, {
					chatId: chat.id
				});
				const contact = await prismaService.wppContact.findUnique({
				where: {
					id: chat.contactId as number
				}
				});
				await prismaService.notification.create({
				data: {
					instance: chat.instance,
					title: "Atendimento finalizado automaticamente",
					description: `O chat com ${contact ? contact.name : chat.contactId} do contato, foi finalizado por inatividade do operador.`,
					chatId: chat.id,
					type: "CHAT_AUTO_FINISHED",
					userId: chat.userId ?? null
				}
				});

			} else {
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

						const deveEncerrar =
						ultimaMensagem !== undefined &&
						Number(ultimaMensagem.timestamp) <= quinzeMinutosAtras.getTime()

					Logger.debug("[CRON] Verificação de encerramento simplificada:");
					Logger.debug(`[CRON] Agora: ${agora.toISOString()} | ${agora.getTime()}`);
					Logger.debug(`[CRON] 15min atrás: ${quinzeMinutosAtras.toISOString()} | ${quinzeMinutosAtras.getTime()}`);
					Logger.debug(`[CRON] Última mensagem: ${ultimaMensagem?.body}`);
					Logger.debug(`[CRON] Timestamp: ${ultimaMensagem ? new Date(ultimaMensagem.timestamp).toISOString() : 'nenhum timestamp'} | ${ultimaMensagem?.timestamp ?? 'nenhum'}`);
					Logger.debug(`[CRON] Deve encerrar? ${deveEncerrar}`);

					if (deveEncerrar) {
					// Finaliza o chat
						await prismaService.wppChat.update({
							where: { id: chat.id },
							data: {
							isFinished: true,
							finishedAt: new Date(),
							finishedBy: null // ou id do sistema
							}
						});

						Logger.debug(`[CRON] Chat ${chat.id} finalizado automaticamente após 15 minutos sem resposta do cliente ou operador.`);

						const event = SocketEventType.WppChatFinished;
						const finishMsg = "Atendimento finalizado automaticamente após 15 minutos sem resposta do cliente e operador.";

						await messagesDistributionService.addSystemMessage(chat, finishMsg);
						await socketService.emit(event, `${chat.instance}:chat:${chat.id}`, { chatId: chat.id });

						const contact = await prismaService.wppContact.findUnique({
							where: { id: chat.contactId as number }
						});

						await prismaService.notification.create({
							data: {
							instance: chat.instance,
							title: "Atendimento finalizado automaticamente",
							description: `O chat com ${contact ? contact.name : chat.contactId} do contato, foi finalizado por inatividade após envio do menu.`,
							chatId: chat.id,
							type: "CHAT_AUTO_FINISHED",
							userId: chat.userId ?? null
							}
						});

					continue; // passa pro próximo chat do loop
					} else {
					// Se não passou o tempo, só continuar normalmente
					Logger.debug(`[CRON] Chat ${chat.id} ainda aguardando resposta do cliente ou operador após envio do menu.`);
					continue;
					}
				}

				const trintaMinAtras = new Date(Date.now() - 30 * 60 * 1000);

				const mensagensOrdenadas = chat.messages
					.filter((m) => m.timestamp)
					.sort(
						(a, b) =>
							new Date(b.timestamp).getTime() -
							new Date(a.timestamp).getTime()
					);

				const ultimaMensagem = mensagensOrdenadas[0];
				if (!ultimaMensagem) continue;

				if (ultimaMensagem.from.startsWith("me:")) {
					const ultimaData = new Date(ultimaMensagem.timestamp);
					if (ultimaData <= trintaMinAtras) {
						// Operador foi o último a responder, mas faz mais de 30 minutos
						const awaitClient =
							"O cliente está aguardando há mais de 30 minutos após sua última resposta. Deseja encerrar ou continuar o atendimento?";

						await messagesDistributionService.addSystemMessage(
							chat,
							awaitClient
						);

						continue; // Evita enviar o menu novamente
					} else {
						Logger.debug(
							`[CRON] Chat ${chat.id} - Operador respondeu recentemente`
						);
						continue;
					}
				}

				const client = chat.messages.find(
					(m) =>
						!m.from.startsWith("me:") &&
						!m.from.startsWith("bot:") &&
						!m.from.startsWith("system")
				);
				if (!client) continue;

				await whatsappService.sendBotMessage(client.from, {
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
			}
		}
	}

	public async createSchedule(
		token: string,
		session: SessionData,
		data: CreateScheduleDTO
	) {
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
