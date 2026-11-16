import { NextFunction, Request, Response } from "express";
import authService from "../services/auth.service";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { isOdimAccessOnly } from "../utils/odim-access-only";
import { enforceOdimAccessOnly } from "./odim-access-only.middleware";
import { assertOperatorFeature, OperatorFeatureError, requiredWhatsAppFeature } from "../operator-features/rollout";

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
		const feature = requiredWhatsAppFeature(req.method, req.route?.path ?? req.path);
		if (feature) assertOperatorFeature(session, feature);
		if (isOdimAccessOnly(session.instance) && !await enforceOdimAccessOnly(req, res)) return;

		next();
	} catch (err) {
		if (err instanceof OperatorFeatureError) {
			res.status(err.status).json({ code: err.code, message: err.message, outcome: err.outcome });
			return;
		}
		res.status(401).json({
			message: "Unauthorized!",
			cause: sanitizeErrorMessage(err)
		});
	}
}
