import { Request, Router } from "express";
import monitorService from "../services/monitor.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import protectedRead from "../middlewares/protected-read";

class MonitorController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/monitor",
			isAuthenticated,
			protectedRead("monitor.legacy", this.getMonitorData)
		);

		this.router.post(
			"/api/whatsapp/monitor/search",
			isAuthenticated,
			protectedRead("monitor.search", this.searchMonitorData)
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
			page: req.body.page,
			pageSize: req.body.pageSize,
			filters: req.body.filters
		});

		return {
			message: "Monitor data retrieved successfully!",
			data: result
		};
	}
}

export default new MonitorController(Router());
