import { Request, Response, Router } from "express";
import schedulesService from "../services/schedules.service";
import chatsService from "../services/chats.service";
import internalChatsService from "../services/internal-chats.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";

class MonitorController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/monitor",
			isAuthenticated,
			this.getMonitorData
		);
	}

	private async getMonitorData(req: Request, res: Response) {
		const schedules = await schedulesService.getSchedulesBySession(
			req.session,
			{}
		);
		const { chats: whatsappChats } = await chatsService.getChatsMonitor(
			req.session,
			false,
			true,
			true
		);
		const { chats: internalChats } =
			await internalChatsService.getInternalChatsMonitor(req.session);

		const responseData = {
			schedules,
			whatsappChats,
			internalChats
		};

		res.status(200).send({
			message: "Monitor data retrieved successfully!",
			data: responseData
		});
	}
}

export default new MonitorController(Router());
