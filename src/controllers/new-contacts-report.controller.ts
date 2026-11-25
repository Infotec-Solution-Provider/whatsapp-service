import { Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import { parseNewContactsQuery } from "../services/new-contacts-report.contract";
import { queryNewContactsReport } from "../services/new-contacts-report.service";
import { currentDatabaseTenant } from "../utils/database-tenant-context";

export function createNewContactsReportRouter() {
	const router = Router();
	router.post("/api/whatsapp/reports/new-contacts/query", isAuthenticated, async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		const instance = currentDatabaseTenant();
		if (!instance || req.session.role.toUpperCase() !== "ADMIN") {
			res.status(403).json({ message: "Acesso restrito aos administradores da empresa." });
			return;
		}
		const instanceContext = req.get("X-CRM-Instance");
		if (instanceContext !== undefined && instanceContext.trim().toLowerCase() !== instance.toLowerCase()) {
			res.status(409).json({ code: "CRM_INSTANCE_CHANGED", message: "A sessão pertence a outra empresa. Atualize a tela." });
			return;
		}

		const query = parseNewContactsQuery(req.body);
		const data = await queryNewContactsReport(instance, query);
		res.json({ data });
	});
	return router;
}
