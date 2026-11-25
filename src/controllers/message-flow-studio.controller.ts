import { UnauthorizedError } from "@rgranatodutra/http-errors";
import { Router, json, type ErrorRequestHandler } from "express";
import isAdmin from "../middlewares/is-admin.middleware";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import { FlowSimulationError, simulateMessageFlow } from "../message-flow/simulation";
import studio, { StudioError } from "../services/message-flow-studio.service";
import parameters from "../services/parameters.service";
import { TriggerError } from "../triage/triggers";
import { createBotTriggerSettingsRouter } from "./bot-trigger-settings.controller";

const router = Router();

function positiveId(input: unknown): number {
	if (typeof input !== "string" || !/^[1-9]\d{0,9}$/.test(input) || Number(input) > 2147483647) {
		throw new StudioError(400, "INVALID_ID", "Identificador inválido.");
	}
	return Number(input);
}

router.use(isAuthenticated, isAdmin, async (req, res, next) => {
	if (!(await parameters.isMessageFlowEditorEnabled(req.session.instance))) {
		res.status(403).json({ code: "FEATURE_DISABLED", message: "O editor de fluxos está desativado nesta empresa." });
		return;
	}
	next();
});
router.use(json({ limit: "1mb" }));

router.use(createBotTriggerSettingsRouter(positiveId));

router.get("/sectors/:sectorId/flows", async (req, res) => {
	res.json(await studio.list(req.session.instance, positiveId(req.params["sectorId"])));
});

router.post("/sectors/:sectorId/flows", async (req, res) => {
	res.status(201).json(await studio.create(req.session.instance, positiveId(req.params["sectorId"]), req.body));
});

router.put("/sectors/:sectorId/flows/:id", async (req, res) => {
	res.json(await studio.update(req.session.instance, positiveId(req.params["sectorId"]), positiveId(req.params.id), req.body));
});

router.post("/sectors/:sectorId/flows/:id/duplicate", async (req, res) => {
	res.status(201).json(await studio.duplicate(req.session.instance, positiveId(req.params["sectorId"]), positiveId(req.params.id), req.body));
});

router.post("/sectors/:sectorId/flows/:id/activate", async (req, res) => {
	res.json(await studio.activate(req.session.instance, positiveId(req.params["sectorId"]), positiveId(req.params.id), req.body));
});

router.post("/sectors/:sectorId/validate", async (req, res) => {
	res.json(await studio.validate(req.session.instance, positiveId(req.params["sectorId"]), req.body));
});

router.post("/sectors/:sectorId/simulate", async (req, res) => {
	const { instance } = req.session;
	const sectorId = positiveId(req.params["sectorId"]);
	const validation = await studio.validate(instance, sectorId, { steps: req.body?.steps });
	if (!validation.valid) {
		res.status(422).json({ code: "INVALID_FLOW", message: validation.errors.join(" "), errors: validation.errors });
		return;
	}
	const { steps, ...input } = req.body;
	res.json(await simulateMessageFlow(instance, sectorId, steps, input));
});

const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
	if (error instanceof StudioError || error instanceof FlowSimulationError || error instanceof TriggerError) {
		res.status(error.status).json({ code: error.code, message: error.message });
	} else if (error instanceof UnauthorizedError) {
		res.status(403).json({ code: "ADMIN_REQUIRED", message: "Acesso restrito a administradores." });
	} else if (error instanceof Error && "type" in error && ["entity.parse.failed", "entity.too.large"].includes(String(error.type))) {
		res.status(error.type === "entity.too.large" ? 413 : 400).json({ code: "INVALID_BODY", message: "Conteúdo da solicitação inválido." });
	} else {
		res.status(500).json({ code: "STUDIO_UNAVAILABLE", message: "Não foi possível concluir a operação nos fluxos." });
	}
};

router.use(handleError);
export default router;
