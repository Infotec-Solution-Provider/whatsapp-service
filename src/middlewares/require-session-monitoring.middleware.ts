import { NextFunction, Request, Response } from "express";
import parametersService from "../services/parameters.service";

export default async function requireSessionMonitoring(req: Request, res: Response, next: NextFunction) {
	const parameters = await parametersService.getSessionParams(req.session);
	if (parameters["feature_whatsapp_session_monitoring_enabled"] !== "true") {
		res.status(403).json({ message: "WhatsApp session monitoring is not enabled" });
		return;
	}

	next();
}