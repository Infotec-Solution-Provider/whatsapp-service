import { Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import { activeUsersReport } from "../services/active-users-report.service";
import { currentDatabaseTenant } from "../utils/database-tenant-context";

export function createActiveUsersReportRouter() {
	const router = Router();
	router.get("/api/whatsapp/reports/active-users", isAuthenticated, async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		const instance = currentDatabaseTenant();
		if (!instance || req.session.role.toUpperCase() !== "ADMIN") {
			res.status(403).json({ message: "Acesso restrito aos administradores da empresa." });
			return;
		}
		const context = req.get("X-CRM-Instance");
		if (context !== undefined && context.trim().toLowerCase() !== instance.toLowerCase()) {
			res.status(409).json({ code: "CRM_INSTANCE_CHANGED", message: "A sessão pertence a outra empresa. Atualize a tela." });
			return;
		}
		res.json({ data: await activeUsersReport(instance) });
	});
	return router;
}
