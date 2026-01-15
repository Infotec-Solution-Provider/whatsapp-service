import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import dashboardService from "../services/dashboard.service";

class DashboardController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/dashboard/contacts-awaiting-return",
			isAuthenticated,
			this.contactsWaitingResponse
		);

		this.router.get(
			"/api/whatsapp/dashboard/messages-per-user",
			isAuthenticated,
			this.messagesPerUser
		);

		this.router.get(
			"/api/whatsapp/dashboard/messages-per-contact",
			isAuthenticated,
			this.messagesPerContact
		);

		this.router.get(
			"/api/whatsapp/dashboard/messages-per-hour-day",
			isAuthenticated,
			this.messagesPerHourDay
		);
	}

	private async contactsWaitingResponse(req: Request, res: Response) {
		const data = await dashboardService.contactsWaitingResponseService(req.session.instance);

		res.status(200).send({
			message: "Contacts awaiting response retrieved successfully!",
			data
		});
	}

	private async messagesPerUser(req: Request, res: Response) {
		const dateFilter = (req.query["date"] as string) || null;

		const data = await dashboardService.messagesPerUserService(req.session.instance, dateFilter);

		res.status(200).send({
			message: "Messages per user retrieved successfully!",
			data
		});
	}

	private async messagesPerContact(req: Request, res: Response) {
		const dateFilter = (req.query["date"] as string) || null;
		const user = req.query["user"] ? Number(req.query["user"]) : null;

		const data = await dashboardService.messagesPerContactService(
			req.session.instance,
			dateFilter,
			Number.isFinite(user) ? user : null
		);

		res.status(200).send({
			message: "Messages per contact retrieved successfully!",
			data
		});
	}

	private async messagesPerHourDay(req: Request, res: Response) {
		const SETORES = (req.query["SETORES"] as string) || "*";
		const OPERADORES = (req.query["OPERADORES"] as string) || "*";
		const MIN_DATE = (req.query["MIN_DATE"] as string) || null;
		const MAX_DATE = (req.query["MAX_DATE"] as string) || null;

		const data = await dashboardService.messagesPerHourDayService(
			req.session.instance,
			SETORES,
			OPERADORES,
			MIN_DATE,
			MAX_DATE
		);

		res.status(200).send({
			message: "Messages per hour/day retrieved successfully!",
			data
		});
	}
}

export default new DashboardController(Router());
