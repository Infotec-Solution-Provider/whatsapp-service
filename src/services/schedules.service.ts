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
		});
		cron.schedule("*/2 * * * *", async () => {
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
						role: "ADMIN"
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
		const trintaMinAtras = new Date(Date.now() - 30 * 60 * 1000)
		const duasHorasAtras = new Date(Date.now() - 2 * 60 * 60 * 1000)

		console.log("Executando rotina de finalização de chats...");
		// Busca os chats ativos iniciados há mais de 30 minutos
		const chats = await prismaService.wppChat.findMany({
			where: {
				isFinished: false,
				startedAt: {
				lte: trintaMinAtras,
				},
			},
			include: {
				messages: {
					where: {
					  timestamp: { gte: duasHorasAtras.toISOString() },
					},
			},
			}})
			console.log("Chats encontrados:", chats.length);
			console.log("Chats:", chats);

			for (const chat of chats) {
			// Verifica se nenhuma mensagem do usuário (operador) foi enviada
			const teveMensagemDeOperador = chat.messages.some(
				msg => msg.from !== msg.to // operador != cliente
			)

			if (!teveMensagemDeOperador) {
				await prismaService.wppChat.update({
				where: { id: chat.id },
				data: {
					isFinished: true,
					finishedAt: new Date(),
					finishedBy: null,
				},
				})
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
