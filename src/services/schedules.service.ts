import { Prisma, WppSchedule } from "@prisma/client";
import prismaService from "./prisma.service";
import { CreateScheduleDTO, SessionData, SocketEventType } from "@in.pulse-crm/sdk";
import chatsService from "./chats.service";
import messagesDistributionService from "./messages-distribution.service";
import cron from "node-cron";
import socketService from "./socket.service";

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
				lte: trintaMinAtras, // não mais recente que 30min
			  },
			},
			include: {
			messages: {
				select: { from: true } // evita trazer conteúdo desnecessário
			},
			},
		})
		console.log(`[CRON] Verificando chats inativos...`)
		console.log(`[CRON] Chats encontrados: ${chats.length}`)
		console.log(`[CRON] Chats encontrados: ${JSON.stringify(chats)}`)
		for (const chat of chats) {
			// Verifica se existe mensagem enviada pelo operador
			const mensagensDoOperador = chat.messages.filter(
				msg => msg.from.startsWith("me:")
			);
			const totalMensagensDoOperador = mensagensDoOperador.length;

			console.log(`[CRON] Chat ${chat.id} - Mensagens do operador: ${totalMensagensDoOperador}`);
			// Finaliza se teve 3 ou menos mensagens do operador
			if (totalMensagensDoOperador === 3) {
			await prismaService.wppChat.update({
				where: { id: chat.id },
				data: {
				isFinished: true,
				finishedAt: new Date(),
				finishedBy: null, // ou ID do sistema
				},
			})
			console.log(`[CRON] Chat ${chat.id} finalizado automaticamente.`)

			const event = SocketEventType.WppChatFinished;

			let finishMsg: string = `Atendimento finalizado pelo sistema devido inatividade do operador.`;
			console.log("Mensagem de finalização:", finishMsg);
			await messagesDistributionService.addSystemMessage(chat, finishMsg);
			await socketService.emit(event, `${"nunes"}:chat:${chat.id}`, {
				chatId: chat.id
			});
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
