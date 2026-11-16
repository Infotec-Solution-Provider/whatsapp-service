import type { NextFunction, Request, Response } from "express";
import isAuthenticated from "./is-authenticated.middleware";
import prismaService from "../services/prisma.service";
import { sameTenantIdentity } from "../utils/odim-access-only";
import { OperatorFeatureError } from "../operator-features/rollout";

/** These legacy editor/debug routes have no JWT boundary. Only ODIM changes here. */
export function guardOdimFlowMutation(kind: "flow" | "step" | "execution") {
	return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
		try {
			const instances: unknown[] = [req.body?.instance, req.body?.targetInstance];
			const id = Number(kind === "step" ? req.params["stepId"] : req.params["id"]);
			if (kind === "flow" && Number.isSafeInteger(id) && id > 0) {
				instances.push((await prismaService.wppMessageFlow.findUnique({ where: { id }, select: { instance: true } }))?.instance);
			}
			if (kind === "step" && Number.isSafeInteger(id) && id > 0) {
				instances.push((await prismaService.wppMessageFlowStep.findUnique({ where: { id }, select: { WppMessageFlow: { select: { instance: true } } } }))?.WppMessageFlow.instance);
			}
			if (kind === "execution") {
				const contactId = Number(req.body?.contactId);
				if (Number.isSafeInteger(contactId) && contactId > 0) instances.push((await prismaService.wppContact.findUnique({ where: { id: contactId }, select: { instance: true } }))?.instance);
			}
			if (!instances.some(instance => typeof instance === "string" && sameTenantIdentity(instance, "odim"))) { next(); return; }
			await isAuthenticated(req, res, () => {
				if (!sameTenantIdentity(req.session.instance, "odim")) throw new OperatorFeatureError();
				if (req.session.role !== "ADMIN") { res.status(403).json({ code: "ADMIN_REQUIRED", message: "Acesso restrito a administradores.", outcome: "NOT_COMMITTED" }); return; }
				next();
			});
		} catch (error) { next(error); }
	};
}
