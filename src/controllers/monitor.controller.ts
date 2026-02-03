import { Request, Response, Router } from "express";
import monitorService from "../services/monitor.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";

class MonitorController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/monitor",
			isAuthenticated,
			this.getMonitorData
		);

		this.router.post(
			"/api/whatsapp/monitor/search",
			isAuthenticated,
			this.searchMonitorData
		);
	}

	private async getMonitorData(req: Request, res: Response) {
		const responseData = await monitorService.getMonitorData(req.session);

		res.status(200).send({
			message: "Monitor data retrieved successfully!",
			data: responseData
		});
	}

	private async searchMonitorData(req: Request, res: Response) {
		const result = await monitorService.searchMonitorData(req.session, {
			page: req.body.page,
			pageSize: req.body.pageSize,
			filters: req.body.filters
		});

		res.status(200).send({
			message: "Monitor data retrieved successfully!",
			data: result
		});
	}
}

export default new MonitorController(Router());
