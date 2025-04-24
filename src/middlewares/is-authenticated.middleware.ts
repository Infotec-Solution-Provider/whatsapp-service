import { NextFunction, Request, Response } from "express";
import authService from "../services/auth.service";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";

export default async function isAuthenticated(
	req: Request,
	res: Response,
	next: NextFunction
) {
	const authToken = req.headers["authorization"] as string;

	if (!authToken) {
		res.status(401).json({
			message: "Unauthorized!"
		});
		return;
	}

	try {
		const session = await authService.fetchSessionData(authToken);
		req.session = session;

		next();
	} catch (err) {
		res.status(401).json({
			message: "Unauthorized!",
			cause: sanitizeErrorMessage(err)
		});
	}
}
