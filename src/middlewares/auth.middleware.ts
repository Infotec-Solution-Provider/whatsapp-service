import type { NextFunction, Request, Response } from "express";

import {
	InternalServerError,
	UnauthenticatedError
} from "@rgranatodutra/http-errors";
import authService from "../services/auth.service";

class AuthMiddleware {
	private static getTokenOrThrow(req: Request) {
		const token = req.headers["Authorization"];

		if (!token || typeof token !== "string") {
			throw new UnauthenticatedError(
				"You have to be logged in to access this resource"
			);
		}

		return token;
	}

	private static getInstanceOrThrow(req: Request) {
		const instance = req.params["instance"];

		if (!instance) {
			throw new InternalServerError(
				"Missing parameter 'instance' for instance scoped route"
			);
		}

		return instance;
	}

	public static async isAuthenticated(
		req: Request,
		_res: Response,
		next: NextFunction
	) {
		const instance = AuthMiddleware.getInstanceOrThrow(req);
		const token = AuthMiddleware.getTokenOrThrow(req);

		const isAuthenticated = await authService.isAuthenticated(
			instance,
			token
		);

		if (!isAuthenticated) {
			throw new UnauthenticatedError("Your session has expired");
		}

		next();
	}

	public static isAuthorized(authorizedRoles: string[]) {
		return async function (
			req: Request,
			_res: Response,
			next: NextFunction
		) {
			const instance = AuthMiddleware.getInstanceOrThrow(req);
			const token = AuthMiddleware.getTokenOrThrow(req);

			const isAuthorized = await authService.isAuthorized(
				instance!,
				token,
				authorizedRoles
			);

			if (!isAuthorized) {
				throw new UnauthenticatedError(
					"You don't have permission to access this resource"
				);
			}

			next();
		};
	}

	public static isAdmin(req: Request, res: Response, next: NextFunction) {
		return AuthMiddleware.isAuthorized(["ADMIN"])(req, res, next);
	}
}

export default AuthMiddleware;
