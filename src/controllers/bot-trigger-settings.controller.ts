import { Router } from "express";
import { triageTriggers } from "../triage/triggers";

export function createBotTriggerSettingsRouter(positiveId: (value: unknown) => number, service = triageTriggers) {
	const router = Router();
	router.get("/sectors/:sectorId/bots", async (req, res) => {
		res.json({ data: await service.adminCatalog(req.session, positiveId(req.params["sectorId"])) });
	});
	router.get("/sectors/:sectorId/bot-triggers", async (req, res) => {
		res.json({ data: await service.settings(req.session, positiveId(req.params["sectorId"])) });
	});
	router.put("/sectors/:sectorId/bot-triggers", async (req, res) => {
		res.json({ data: await service.replace(req.session, positiveId(req.params["sectorId"]), req.body) });
	});
	router.post("/sectors/:sectorId/bot-triggers/simulate", async (req, res) => {
		res.json({ data: await service.simulate(req.session, positiveId(req.params["sectorId"]), req.body) });
	});
	return router;
}
