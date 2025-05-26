import { Prisma, WppSchedule } from "@prisma/client";
import prismaService from "./prisma.service";
import {
	CreateScheduleDTO,
	SessionData,
	SocketEventType
} from "@in.pulse-crm/sdk";
import chatsService from "./chats.service";
import messagesDistributionService from "./messages-distribution.service";
import cron from "node-cron";
import socketService from "./socket.service";
import { Logger } from "@in.pulse-crm/utils";
import whatsappService from "./whatsapp.service";
import chooseSectorBot from "../bots/choose-sector.bot";

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

			await chatsService.startScheduledChat(
				schedule.instance,
				schedule.sectorId!,
				schedule.contactId,
				schedule.scheduledFor
			);

			await this.deleteSchedule(schedule.id);
		}
	}

	public async getSchedulesBySession(
		session: SessionData,
		filters: ChatsFilters
	) {
		const whereClause: Prisma.WppScheduleWhereInput = {};
		whereClause.instance = session.instance;

		if (filters.userId) {
			whereClause.scheduledFor = +filters.userId;
		}

		if (filters.sectorId) {
			whereClause.sectorId = +filters.sectorId;
		}

		const schedules = await prismaService.wppSchedule.findMany({
			where: whereClause
		});

		return schedules;
	}
	public async finishChatRoutine() {
		const agora = new Date();
		const trintaMinAtras = new Date(agora.getTime() - 30 * 60 * 1000);
		const duasHorasAtras = new Date(agora.getTime() - 2 * 60 * 60 * 1000);

		// Busca os chats ativos iniciados há mais de 30 minutos e menos de 2 horas
		const chats = await prismaService.wppChat.findMany({
			where: {
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
						timestamp: true
					}
				},
			},
		})

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
					finishedBy: null, // ou ID do sistema
					},
				})
				Logger.debug(`[CRON] Chat ${chat.id} finalizado automaticamente.`);

				const event = SocketEventType.WppChatFinished;

				let finishMsg: string = `Atendimento finalizado pelo sistema devido inatividade do operador.`;
				Logger.debug("Mensagem de finalização:", finishMsg);
				await messagesDistributionService.addSystemMessage(chat, finishMsg);
				await socketService.emit(event, `${"nunes"}:chat:${chat.id}`, {
					chatId: chat.id
				});
			}
			else{

				const trintaMinAtras = new Date(Date.now() - 30 * 60 * 1000);

				const ultimaMsgOperador = chat.messages
				.filter(m => m.from.startsWith("me:"))
				.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

				if (ultimaMsgOperador && new Date(ultimaMsgOperador.timestamp) > trintaMinAtras) {
				console.log(`[CRON] Chat ${chat.id} - Operador respondeu nos últimos 30min`);
				continue;
				}

				const client = chat.messages.find(m => !m.from.startsWith("me:") && !m.from.startsWith("bot:"));
				if(!client) return
				await whatsappService.sendBotMessage(client.from, {
					chat,
					text: [
					"Deseja voltar ao menu de setores, encerrar o atendimento ou continuar aguardando?",
					"",
					"*1* - Voltar ao menu de setores",
					"*2* - Encerrar o atendimento",
					"*3* - Continuar aguardando",
					"",
					"*Responda apenas com o número da opção desejada.*"
					].join('\n')
				});
				await prismaService.wppChat.update({
					where: { id: chat.id },
					data: { userId:null, botId: 1 }
				});
				chooseSectorBot.forceStep(chat.id, 4);

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
				sectorId: session.sectorId
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
