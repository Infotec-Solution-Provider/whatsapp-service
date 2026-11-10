import type { Request, Response, NextFunction } from "express";
import prisma from "../services/prisma.service";
import { isOdimAccessOnly, sameTenantIdentity } from "../utils/odim-access-only";
import isAuthenticated from "./is-authenticated.middleware";

/** The old anonymous message lookup must never disclose newly copied Odim data. */
export default async function protectOdimCopiedMessage(req: Request, res: Response, next: NextFunction) {
 const id = Number(req.params["id"]);
 if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ code: "INVALID_MESSAGE_ID" }); return; }
 const row = await prisma.wppMessage.findUnique({ where: { id }, select: { instance: true } });
 if (row && isOdimAccessOnly(row.instance)) {
  await isAuthenticated(req, res, () => { if (!sameTenantIdentity(req.session.instance, row.instance)) { res.status(404).json({ code: "MESSAGE_NOT_FOUND" }); return; } next(); }); return;
 }
 next();
}
