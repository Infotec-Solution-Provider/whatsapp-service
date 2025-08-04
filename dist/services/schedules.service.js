"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = __importDefault(require("./prisma.service"));
class SchedulesService {
    async getSchedulesBySession(session, filters) {
        const whereClause = {};
        whereClause.instance = session.instance;
        if (filters.userId) {
            whereClause.scheduledFor = +filters.userId;
        }
        if (filters.sectorId) {
            whereClause.sectorId = +filters.sectorId;
        }
        const schedules = await prisma_service_1.default.wppSchedule.findMany({
            where: whereClause
        });
        return schedules;
    }
    async createSchedule(scheduleData) {
        const schedules = await prisma_service_1.default.wppSchedule.create({
            data: scheduleData
        });
        return schedules;
    }
    async editSchedule(scheduleData, scheduleId) {
        const schedules = await prisma_service_1.default.wppSchedule.update({
            where: { id: scheduleId },
            data: scheduleData
        });
        return schedules;
    }
    async deleteSchedule(scheduleId) {
        const schedules = await prisma_service_1.default.wppSchedule.delete({
            where: { id: scheduleId }
        });
        return schedules;
    }
}
exports.default = new SchedulesService();
