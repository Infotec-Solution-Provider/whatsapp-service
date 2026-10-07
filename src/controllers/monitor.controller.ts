import { Request, Router } from "express";
import monitorService from "../services/monitor.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import protectedRead from "../middlewares/protected-read";
import isAdmin from "../middlewares/is-admin.middleware";

class MonitorController {
	constructor(public readonly router: Router) {
		this.router.get("/api/whatsapp/monitor", isAuthenticated, protectedRead("monitor.legacy", this.getMonitorData));

		this.router.post(
			"/api/whatsapp/monitor/search",
			isAuthenticated,
			isAdmin,
			protectedRead("monitor.search", this.searchMonitorData)
		);
		this.router.post(
			"/api/whatsapp/monitor/summary",
			isAuthenticated,
			isAdmin,
			protectedRead("monitor.summary", this.getMonitorSummary)
		);
		this.router.get(
			"/api/whatsapp/monitor/chats/:type/:id/messages",
			isAuthenticated,
			isAdmin,
			protectedRead("monitor.messages", this.getMonitorMessages)
		);
	}

	private async getMonitorData(req: Request) {
		const responseData = await monitorService.getMonitorData(req.session);

		return {
			message: "Monitor data retrieved successfully!",
			data: responseData
		};
	}

	private async searchMonitorData(req: Request) {
		const result = await monitorService.searchMonitorData(req.session, {
			page: req.body?.page,
			pageSize: req.body?.pageSize,
			filters: req.body?.filters
		});

		return {
			message: "Monitor data retrieved successfully!",
			data: result
		};
	}

	private async getMonitorSummary(req: Request) {
		return { data: await monitorService.getMonitorSummary(req.session, { filters: req.body?.filters }) };
	}

	private async getMonitorMessages(req: Request) {
		return {
			data: await monitorService.getMonitorMessages(req.session, {
				type: req.params["type"],
				id: req.params["id"],
				limit: req.query["limit"],
				beforeId: req.query["beforeId"]
			})
		};
	}
}

export default new MonitorController(Router());
