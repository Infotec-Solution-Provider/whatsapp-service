import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import { isOdimAccessOnly } from "../utils/odim-access-only";
import parameters from "../services/parameters.service";
import prisma from "../services/prisma.service";
import { historyId, OdimReadonlyHistory } from "../services/odim-readonly-history.core";

const router = Router();
const base = "/api/whatsapp/odim-history";
const query = (sql: string, values: unknown[]) => prisma.$queryRawUnsafe<any[]>(sql, ...values);
async function handle(req: Request, res: Response, action: (history: OdimReadonlyHistory) => Promise<unknown> | unknown) {
 res.setHeader("Cache-Control", "no-store");
 if (!isOdimAccessOnly(req.session.instance)) return res.status(404).json({ code: "HISTORY_NOT_AVAILABLE" });
 if (req.session.role !== "ADMIN") return res.status(403).json({ code: "ADMIN_REQUIRED" });
 try {
 const flags = await parameters.getSessionParams(req.session);
 if (flags["feature_legacy_history_enabled"] !== "true") return res.status(404).json({ code: "FEATURE_DISABLED" });
 const snapshots = await query("SELECT id,source_snapshot_at,manifest FROM legacy_readonly_history_snapshots WHERE instance='odim' AND state='PUBLISHED' ORDER BY created_at DESC LIMIT 1", []);
 if (!snapshots.length) return res.status(503).json({ code: "HISTORY_NOT_PUBLISHED" });
  const data = await action(new OdimReadonlyHistory({ query }, snapshots[0]));
  if (data === null) return res.status(404).json({ code: "HISTORY_RESOURCE_NOT_FOUND" });
  return res.status(200).json({ data });
 } catch (error) {
  if (error instanceof Error && error.message.startsWith("INVALID_HISTORY_")) return res.status(400).json({ code: error.message });
  return res.status(500).json({ code: "HISTORY_READ_FAILED" });
 }
}
router.get(base + "/status", isAuthenticated, (req, res) => handle(req, res, h => h.metadata()));
for (const kind of ["chats", "contacts"] as const) {
 router.get(base + "/" + kind, isAuthenticated, (req, res) => handle(req, res, h => h.list(kind, req.query)));
 router.get(base + "/" + kind + "/:id/messages", isAuthenticated, (req, res) => handle(req, res, h => h.messages(kind, historyId(req.params["id"]), req.query)));
}
router.get(base + "/chats/:id/events", isAuthenticated, (req, res) => handle(req, res, h => h.messages("chats", historyId(req.params["id"]), req.query, true)));
export default { router };
