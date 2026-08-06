import { UnauthorizedError } from "@rgranatodutra/http-errors";
import { NextFunction, Request, Response } from "express";

export default function isAdmin(req: Request, _res: Response, next: NextFunction) {
	if (req.session.role !== "ADMIN") {
		throw new UnauthorizedError("Acesso restrito a administradores.");
	}

	next();
}
