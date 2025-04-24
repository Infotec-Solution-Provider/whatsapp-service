import { Prisma, WppSchedule } from "@prisma/client";
import prismaService from "./prisma.service";
import { SessionData } from "@in.pulse-crm/sdk";

interface ChatsFilters {
	userId?: string;
	sectorId?: string;
}

class SchedulesService {
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

	public async createSchedule(scheduleData: WppSchedule) {
		const schedules = await prismaService.wppSchedule.create({
			data: scheduleData
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
