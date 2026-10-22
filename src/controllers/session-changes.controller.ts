import { BadRequestError } from "@rgranatodutra/http-errors";
import { Request, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import protectedRead from "../middlewares/protected-read";
import sessionChanges from "../services/session-changes/session-changes.service";

class SessionChangesController {
	public readonly router = Router();
	constructor() {
		this.router.get("/api/whatsapp/session/changes", isAuthenticated, protectedRead("session.changes", this.read));
	}
	private async read(req: Request) {
		const limit = req.query["limit"] === undefined ? 100 : Number(req.query["limit"]);
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestError("limit must be between 1 and 100");
		return { data: await sessionChanges.read(req.session, req.query["cursor"], limit) };
	}
}
export default new SessionChangesController();
