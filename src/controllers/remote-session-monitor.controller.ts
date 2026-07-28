import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import requireSessionMonitoring from "../middlewares/require-session-monitoring.middleware";
import remoteSessionMonitorService, { RemoteSessionMonitorError } from "../services/remote-session-monitor.service";

const ENDPOINT = "/api/whatsapp/session-monitor/clients";

class RemoteSessionMonitorController {
	constructor(public readonly router: Router) {
		router.get(ENDPOINT, isAuthenticated, requireSessionMonitoring, this.listClients);
		router.get(`${ENDPOINT}/:clientId`, isAuthenticated, requireSessionMonitoring, this.getClientDetail);
		router.post(`${ENDPOINT}/:clientId/restart`, isAuthenticated, requireSessionMonitoring, this.restart);
		router.post(`${ENDPOINT}/:clientId/reset-qr`, isAuthenticated, requireSessionMonitoring, this.resetForQr);
		router.get(`${ENDPOINT}/:clientId/qr`, isAuthenticated, requireSessionMonitoring, this.getQr);
	}

	private listClients = async (req: Request, res: Response) => {
		try {
			res.status(200).json(await remoteSessionMonitorService.listClients(req.session));
		} catch (error) {
			this.sendError(error, res);
		}
	};

	private getClientDetail = async (req: Request, res: Response) => {
		try {
			res.status(200).json(await remoteSessionMonitorService.getClientDetail(req.session, this.clientId(req)));
		} catch (error) {
			this.sendError(error, res);
		}
	};

	private restart = async (req: Request, res: Response) => {
		try {
			res.status(202).json(await remoteSessionMonitorService.restart(req.session, this.clientId(req)));
		} catch (error) {
			this.sendError(error, res);
		}
	};

	private resetForQr = async (req: Request, res: Response) => {
		try {
			res.status(202).json(await remoteSessionMonitorService.resetForQr(req.session, this.clientId(req), req.body?.confirm === true));
		} catch (error) {
			this.sendError(error, res);
		}
	};

	private getQr = async (req: Request, res: Response) => {
		try {
			const qr = await remoteSessionMonitorService.getQr(req.session, this.clientId(req));
			res.setHeader("Cache-Control", "no-store");
			res.status(200).json(qr);
		} catch (error) {
			this.sendError(error, res);
		}
	};

	private clientId(req: Request): number {
		const clientId = Number(req.params["clientId"]);
		if (!Number.isInteger(clientId) || clientId <= 0) {
			throw new RemoteSessionMonitorError(400, "Invalid WhatsApp client id");
		}
		return clientId;
	}

	private sendError(error: unknown, res: Response): void {
		if (error instanceof RemoteSessionMonitorError) {
			res.status(error.statusCode).json({ message: error.message });
			return;
		}

		res.status(500).json({ message: "Unable to monitor the WhatsApp session" });
	}
}

export default new RemoteSessionMonitorController(Router());