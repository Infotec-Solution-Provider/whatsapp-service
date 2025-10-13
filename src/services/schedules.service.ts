import { Prisma, WppContact, WppSchedule } from "@prisma/client";
import prismaService from "./prisma.service";
import { CreateScheduleDTO, Customer, SessionData } from "@in.pulse-crm/sdk";
import chatsService, { FETCH_CUSTOMERS_QUERY } from "./chats.service";
import messagesDistributionService from "./messages-distribution.service";
import cron from "node-cron";
import { Logger } from "@in.pulse-crm/utils";
import instancesService from "./instances.service";
import runIdleChatsRoutine from "../routines/idle-chats.routine";

interface ChatsFilters {
	userId?: string;
	sectorId?: string;
}
class SchedulesService {
	constructor() {
		cron.schedule("*/20 * * * * *", () => {
			this.runSchedulesJob();
			runIdleChatsRoutine();
		});
	}

	private async runSchedulesJob() {
		try {
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
		} catch (err: any) {
			Logger.error("Erro ao executar job de agendamentos: ", err);
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
