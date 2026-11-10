import type { Request, Response } from "express";
import prismaService, { type DatabaseClient } from "../services/prisma.service";
import { odimLocalRequestAllowed, OdimAccessOnlyError } from "../utils/odim-access-only";
import parameters from "../services/parameters.service";

const COPY_READS = new Set(["/api/whatsapp/monitor", "/api/whatsapp/monitor/search", "/api/whatsapp/session/monitor", "/api/whatsapp/chats/:id", "/api/whatsapp/chats/:id/messages", "/api/whatsapp/messages/:id"]);

/** Called only after authentication and only for the Odim access-only profile. */
export async function enforceOdimAccessOnly(req: Request, res: Response, db: DatabaseClient = prismaService): Promise<boolean> {
	const route: unknown = req.route?.path;
	if (typeof route === "string" && COPY_READS.has(route)) {
	 const flags = await parameters.getSessionParams(req.session);
	 if (flags["feature_odim_usable_copy_enabled"] !== "true") { const e = new OdimAccessOnlyError(); res.status(e.statusCode).json({ code: e.code, message: e.message }); return false; }
	 if (req.session.role === "EXTERNO" || ((route.includes("/monitor") || route === "/api/whatsapp/session/monitor") && req.session.role !== "ADMIN")) { res.status(403).json({ code: "COPY_ACCESS_DENIED" }); return false; }
	 if (req.params["id"]) {
	  const id = Number(req.params["id"]); if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ code: "INVALID_RESOURCE_ID" }); return false; }
	  const own = req.session.role === "ADMIN" ? {} : { userId: req.session.userId };
	  const found = route === "/api/whatsapp/messages/:id"
	   ? await db.wppMessage.findFirst({ where: { id, instance: req.session.instance, ...(req.session.role === "ADMIN" ? {} : { WppChat: { instance: req.session.instance, ...own } }) }, select: { id: true } })
	   : await db.wppChat.findFirst({ where: { id, instance: req.session.instance, ...own }, select: { id: true } });
	  if (!found) { res.status(404).json({ code: "RESOURCE_NOT_FOUND" }); return false; }
	 }
	}
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
