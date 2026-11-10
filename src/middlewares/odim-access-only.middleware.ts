import type { Request, Response } from "express";
import prismaService, { type DatabaseClient } from "../services/prisma.service";
import { odimLocalRequestAllowed, OdimAccessOnlyError } from "../utils/odim-access-only";

/** Called only after authentication and only for the Odim access-only profile. */
export async function enforceOdimAccessOnly(req: Request, res: Response, db: DatabaseClient = prismaService): Promise<boolean> {
	const route: unknown = req.route?.path;
	if (!odimLocalRequestAllowed(req.method, route)) {
		const error = new OdimAccessOnlyError();
		res.status(error.statusCode).json({ message: error.message, code: error.code });
		return false;
	}
	if (req.method === "GET" || typeof route !== "string" || !route.startsWith("/api/internal/")) return true;
	const rawId = req.params["id"];
	if (!rawId) return true;
	const id = Number(rawId);
	if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ message: "Invalid internal resource." }); return false; }
	const chat = route.startsWith("/api/internal/messages/")
		? (await db.internalMessage.findFirst({ where: { id, instance: req.session.instance, chat: { instance: req.session.instance } }, select: { chat: { select: { wppGroupId: true } } } }))?.chat
		: await db.internalChat.findFirst({ where: { id, instance: req.session.instance }, select: { wppGroupId: true } });
	if (!chat) { res.status(404).json({ message: "Internal resource not found in this instance." }); return false; }
	if (chat.wppGroupId) {
		const error = new OdimAccessOnlyError();
		res.status(error.statusCode).json({ message: error.message, code: error.code });
		return false;
	}
	return true;
}
