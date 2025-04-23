import { NextFunction, Request, Response } from "express";
import authService from "../services/auth.service";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";

export default async function isAuthenticated(
	req: Request,
	res: Response,
	next: NextFunction
) {
	const authToken = req.headers["authorization"] as string;

	console.log("foi 1");
	if (!authToken) {
		console.log("F 1");
		res.status(401).json({
			message: "Unauthorized!"
		});
		return;
	}

	console.log("foi 2");

	try {
		const session = await authService.fetchSessionData(authToken);
		req.session = session;

		console.log("foi 3");
		next();
	} catch (err) {
		console.error("f", err);
		res.status(401).json({
			message: "Unauthorized!",
			cause: sanitizeErrorMessage(err)
		});
	}
}
