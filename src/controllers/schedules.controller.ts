import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import schedulesService from "../services/schedules.service";
import { BadRequestError } from "@rgranatodutra/http-errors";
import { WppSchedule } from "@prisma/client";

interface SchedulesFilters {
	userId?: string;
	sectorId?: string;
}

class ChatsController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/schedules",
			isAuthenticated,
			this.getSchedulesBySession
		);
		this.router.post(
			"/api/whatsapp/schedules",
			isAuthenticated,
			this.createSchedule
		);
		this.router.patch(
			"/api/whatsapp/schedules/:id",
			isAuthenticated,
			this.editSchedule
		);
		this.router.delete(
			"/api/whatsapp/schedules/:id",
			isAuthenticated,
			this.deleteSchedule
		);
	}

	private async getSchedulesBySession(req: Request, res: Response) {
		const { userId, sectorId } = req.query as SchedulesFilters;
		let filters = {};

		if (userId && isNaN(Number(userId))) {
			throw new BadRequestError("User ID must be a number!");
		} else {
			filters = { ...filters, userId: Number(userId) };
		}

		if (sectorId && isNaN(Number(sectorId))) {
			throw new BadRequestError("Sector ID must be a number!");
		} else {
			filters = { ...filters, sectorId: Number(sectorId) };
		}

		const data = await schedulesService.getSchedulesBySession(
			req.session,
			filters
		);

		res.status(200).send({
			message: "Schedules retrieved successfully!",
			data
		});
	}

	private async createSchedule(req: Request, res: Response) {
		const session = req.session;
		const formData = req.body;

		if (!formData || typeof formData !== "object") {
			throw new BadRequestError("Invalid or missing formData!");
		}

		const scheduleData = {
			...formData,
			scheduleDate: new Date(formData.scheduleDate),
			instance: session.instance
		} as WppSchedule;

		if (!scheduleData.name || typeof scheduleData.name !== "string") {
			throw new BadRequestError(
				"Schedule name is required and must be a string!"
			);
		}

		if (
			!scheduleData.contactId ||
			typeof scheduleData.contactId !== "number"
		) {
			throw new BadRequestError(
				"Contact ID is required and must be a number!"
			);
		}

		if (
			!scheduleData.scheduleDate ||
			!(scheduleData.scheduleDate instanceof Date)
		) {
			throw new BadRequestError("Valid schedule date is required!");
		}

		if (
			!scheduleData.scheduledBy ||
			typeof scheduleData.scheduledBy !== "number"
		) {
			throw new BadRequestError(
				"Scheduled By is required and must be a number!"
			);
		}

		if (
			!scheduleData.scheduledFor ||
			typeof scheduleData.scheduledFor !== "number"
		) {
			throw new BadRequestError(
				"Scheduled For is required and must be a number!"
			);
		}

		if (
			!scheduleData.sectorId ||
			typeof scheduleData.sectorId !== "number"
		) {
			throw new BadRequestError(
				"Sector ID is required and must be a number!"
			);
		}

		const result = await schedulesService.createSchedule(scheduleData);

		res.status(200).send({
			message: "Schedule created successfully!",
			data: result
		});
	}

	private async editSchedule(req: Request, res: Response) {
		const formData = req.body;
		const { id } = req.params;

		if (!id) {
			throw new BadRequestError("Message ID is required!");
		}

		if (!formData || typeof formData !== "object") {
			throw new BadRequestError("Invalid or missing formData!");
		}

		let scheduleData = formData as WppSchedule;

		if (scheduleData.name && typeof scheduleData.name !== "string") {
			throw new BadRequestError("Schedule name must be a string!");
		}

		if (
			scheduleData.contactId &&
			typeof scheduleData.contactId !== "number"
		) {
			throw new BadRequestError("Contact ID must be a number!");
		}

		if (
			scheduleData.scheduleDate &&
			!(scheduleData.scheduleDate instanceof Date)
		) {
			throw new BadRequestError("Invalid schedule date!");
		}

		if (
			scheduleData.scheduledBy &&
			typeof scheduleData.scheduledBy !== "number"
		) {
			throw new BadRequestError("Scheduled By must be a number!");
		}

		if (
			scheduleData.scheduledFor &&
			typeof scheduleData.scheduledFor !== "number"
		) {
			throw new BadRequestError("Scheduled For must be a number!");
		}

		if (
			scheduleData.sectorId &&
			typeof scheduleData.sectorId !== "number"
		) {
			throw new BadRequestError("Sector ID must be a number!");
		}

		const result = await schedulesService.editSchedule(scheduleData, +id);

		res.status(200).send({
			message: "Schedule patched successfully!",
			data: result
		});
	}

	private async deleteSchedule(req: Request, res: Response) {
		const { id } = req.params;

		if (!id) {
			throw new BadRequestError("Message ID is required!");
		}

		const result = await schedulesService.deleteSchedule(+id);

		res.status(200).send({
			message: "Schedule deleted successfully!",
			data: result
		});
	}
}

export default new ChatsController(Router());
