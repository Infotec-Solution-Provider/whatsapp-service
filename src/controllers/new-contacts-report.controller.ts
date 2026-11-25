import { Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import {
	canReadNewContactsReport,
	NEW_CONTACTS_PILOT_INSTANCE,
	parseNewContactsQuery
} from "../services/new-contacts-report.contract";
import { queryNewContactsReport } from "../services/new-contacts-report.service";
import { withDatabaseTenant } from "../utils/database-tenant-context";

export function createNewContactsReportRouter() {
	const router = Router();
	router.post("/api/whatsapp/reports/new-contacts/query", isAuthenticated, async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!canReadNewContactsReport(req.session)) {
			res.status(403).json({ message: "Acesso restrito aos administradores da empresa participante." });
			return;
		}

		const query = parseNewContactsQuery(req.body);
		const data = await withDatabaseTenant(
			NEW_CONTACTS_PILOT_INSTANCE,
			() => queryNewContactsReport(NEW_CONTACTS_PILOT_INSTANCE, query)
		);
		res.json({ data });
	});
	return router;
}
