import { Prisma, WppContact, WppSchedule } from "@prisma/client";
import prismaService from "./prisma.service";
import { CreateScheduleDTO, Customer, SessionData } from "@in.pulse-crm/sdk";
import chatsService, { FETCH_CUSTOMERS_QUERY } from "./chats.service";
import cron from "node-cron";
import instancesService from "./instances.service";
import runIdleChatsJob from "../routines/idle-chats.routine";
import runSchedulesJob from "../routines/schedules.routine";

interface ChatsFilters {
	userId?: string;
	sectorId?: string;
}
class SchedulesService {
	private isSchedulesJobRunning: boolean = false;
	private isIdleChatsJobRunning: boolean = false;

	constructor() {
		cron.schedule("*/1 * * * *", () => {
			if (!this.isSchedulesJobRunning) {
				this.isSchedulesJobRunning = true;
				runSchedulesJob().finally(() => {
					this.isSchedulesJobRunning = false;
				});
			}
		});
		cron.schedule("*/1 * * * *", () => {
			if (!this.isIdleChatsJobRunning) {
				this.isIdleChatsJobRunning = true;
				runIdleChatsJob().finally(() => {
					this.isIdleChatsJobRunning = false;
				});
			}
		});
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

	public async createSchedule(session: SessionData, data: CreateScheduleDTO) {
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
			const systemMsg = `Esse atendimento foi agendado para retorno em ${date.toLocaleString('pt-BR')}.\nAgendado por ${session.name}.`;
			await chatsService.systemFinishChatById(chat.id, systemMsg);
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
