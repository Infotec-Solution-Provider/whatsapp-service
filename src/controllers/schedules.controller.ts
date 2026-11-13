import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import schedulesService from "../services/schedules.service";
import unifiedSchedulesService from "../services/unified-schedules.service";
import { BadRequestError, UnauthorizedError } from "@rgranatodutra/http-errors";
import { CreateScheduleDTO } from "../sdk-local";
import { UnifiedScheduleFilters } from "../types/unified-schedule.types";
import protectedRead from "../middlewares/protected-read";
interface SchedulesFilters {
	userId?: string;
	sectorId?: string;
}
class SchedulesController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/schedules/mine",
			isAuthenticated,
			(_req, res, next) => {
				res.setHeader("Cache-Control", "private, no-store");
				res.vary("Authorization");
				next();
			},
			protectedRead("schedules.mine", async req => unifiedSchedulesService.getMySchedules(req.session, req.query))
		);
		this.router.get("/api/whatsapp/schedules/unified", isAuthenticated, this.getUnifiedSchedulesBySession);
		this.router.get("/api/whatsapp/schedules", isAuthenticated, this.getSchedulesBySession);
		this.router.post("/api/whatsapp/schedules", isAuthenticated, this.createSchedule);
		this.router.patch("/api/whatsapp/schedules/:id", isAuthenticated, this.editSchedule);
		this.router.delete("/api/whatsapp/schedules/:id", isAuthenticated, this.deleteSchedule);
	}

	private async getUnifiedSchedulesBySession(req: Request, res: Response) {
		const filters = req.query as UnifiedScheduleFilters;
		const result = await unifiedSchedulesService.getUnifiedSchedules(req.session, filters);

		res.status(200).send(result);
	}

	private async getSchedulesBySession(req: Request, res: Response) {
		const { userId, sectorId } = req.query as SchedulesFilters;
		if (req.session.role !== "ADMIN" && (
			(userId !== undefined && Number(userId) !== req.session.userId) ||
			(sectorId !== undefined && Number(sectorId) !== req.session.sectorId)
		)) {
			throw new UnauthorizedError("Você não pode consultar a agenda de outro operador ou setor.");
		}
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
		if (req.session.role !== "ADMIN") filters = { userId: req.session.userId, sectorId: req.session.sectorId };

		const data = await schedulesService.getSchedulesBySession(req.session, filters);

		res.status(200).send({
			message: "Schedules retrieved successfully!",
			data
		});
	}

	private async createSchedule(req: Request, res: Response) {
		const session = req.session;
		const input = req.body;

		if (!input || typeof input !== "object") {
			throw new BadRequestError("Invalid or missing formData!");
		}

		if (!input.contactId || typeof input.contactId !== "number") {
			throw new BadRequestError("Contact ID is required and must be a number!");
		}

		if (!input.date) {
			throw new BadRequestError("Schedule date is required!");
		}

		if (!input.scheduledFor || typeof input.scheduledFor !== "number") {
			throw new BadRequestError("Scheduled For is required and must be a number!");
		}

		if (!input.sectorId || typeof input.sectorId !== "number") {
			throw new BadRequestError("Sector ID is required and must be a number!");
		}

		const result = await schedulesService.createSchedule(session, input as CreateScheduleDTO);

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

		const result = await schedulesService.editSchedule(req.session, formData, id);

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

		const result = await schedulesService.deleteSchedule(req.session, id);

		res.status(200).send({
			message: "Schedule deleted successfully!",
			data: result
		});
	}
}

export default new SchedulesController(Router());
