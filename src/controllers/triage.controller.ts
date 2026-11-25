import express, { type RequestHandler } from "express";
import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import { triageAuthoring } from "../triage/authoring";
import { requestBody } from "../triage/access";
import { TriageNotPrepared, readinessMessage, unavailableDatabase } from "../triage/readiness";
import positiveResourceId from "../utils/positive-resource-id";
import { getTriageActivity } from "../triage/activity";
import { takeOverTriage } from "../triage/dispatch";
import { manualTriageAvailability, startTriggeredTriage } from "../triage/trigger-start";

export function createTriageRouter(
	service = triageAuthoring,
	authenticate: RequestHandler = isAuthenticated,
	activity = getTriageActivity,
	takeover = takeOverTriage,
	checkManual = manualTriageAvailability,
	startManual: (
		input: Parameters<typeof startTriggeredTriage>[0]
	) => Promise<{ chat: { id: number }; started: boolean } | null> = startTriggeredTriage
) {
	const router = express.Router();
	router.use(authenticate, express.json({ limit: "256kb" }));
	router.use(async (req, _res, next) => {
		await service.requirePrepared(req.session);
		next();
	});
	router.get("/context", async (req, res) => {
		res.json({ data: await service.context(req.session) });
	});
	router.get("/operators", async (req, res) => {
		res.json({ data: await service.operators(req.session, req.query["search"] ?? "") });
	});
	router.get("/channels/:id", async (req, res) => {
		res.json({ data: await service.get(req.session, positiveResourceId(req.params["id"])) });
	});
	router.get("/channels/:id/bots", async (req, res) => {
		res.json({ data: await service.listBots(req.session, positiveResourceId(req.params["id"])) });
	});
	router.post("/channels/:id/bots", async (req, res) => {
		res.status(201).json({
			data: await service.createBot(req.session, positiveResourceId(req.params["id"]), req.body)
		});
	});
	router.get("/channels/:id/bots/:botId", async (req, res) => {
		res.json({
			data: await service.get(
				req.session,
				positiveResourceId(req.params["id"]),
				positiveResourceId(req.params["botId"])
			)
		});
	});
	for (const prefix of ["/channels/:id", "/channels/:id/bots/:botId"]) {
		for (const [method, path, action] of [
			["put", "draft", "save"],
			["post", "publish", "publish"],
			["post", "rollback", "rollback"],
			["post", "pause", "pause"]
		] as const)
			router[method](prefix + "/" + path, async (req, res) => {
				const botId = req.params["botId"];
				res.json({
					data: await service.mutate(
						req.session,
						positiveResourceId(req.params["id"]),
						action,
						req.body,
						botId === undefined ? undefined : positiveResourceId(botId)
					)
				});
			});
	}
	for (const action of ["validate", "simulate"] as const) {
		router.post("/channels/:id/" + action, async (req, res) => {
			res.json({
				data: await service.preview(
					req.session,
					positiveResourceId(req.params["id"]),
					req.body,
					action === "simulate"
				)
			});
		});
	}
	router.get("/channels/:id/grants", async (req, res) => {
		res.json({ data: await service.grants(req.session, positiveResourceId(req.params["id"])) });
	});
	router.put("/channels/:id/grants/:userId", async (req, res) => {
		res.json({
			data: await service.setGrant(
				req.session,
				positiveResourceId(req.params["id"]),
				positiveResourceId(req.params["userId"]),
				req.body
			)
		});
	});
	router.get("/channels/:id/activity", async (req, res) => {
		const id = positiveResourceId(req.params["id"]);
		await service.requireChannel(req.session, id);
		res.json({ data: await activity(req.session.instance, id) });
	});
	router.get("/channels/:id/chats/:chatId/start", async (req, res) => {
		const channelId = positiveResourceId(req.params["id"]),
			chatId = positiveResourceId(req.params["chatId"]);
		await service.requireChannel(req.session, channelId);
		const bots = await checkManual(req.session.instance, channelId, chatId, req.session.userId);
		res.json({ data: { available: bots.length > 0, bots } });
	});
	router.post("/channels/:id/chats/:chatId/start", async (req, res) => {
		const channelId = positiveResourceId(req.params["id"]),
			chatId = positiveResourceId(req.params["chatId"]);
		await service.requireChannel(req.session, channelId);
		const body = requestBody(req.body, ["requestId", "botId"]);
		const requestId = body["requestId"];
		const botId = positiveResourceId(body["botId"]);
		if (
			typeof requestId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
		)
			throw new BadRequestError("Informe um identificador único de solicitação.");
		const result = await startManual({
			instance: req.session.instance,
			channelId,
			botId,
			chatId,
			type: "manual",
			actorId: req.session.userId,
			eventKey: requestId.toLowerCase(),
			authorizeTx: async (tx) => {
				await service.requireChannel(req.session, channelId, tx);
			}
		});
		if (!result) throw new ConflictError("Este atendimento não está disponível para iniciar o bot neste canal.");
		res.json({ data: { started: result.started, chatId: result.chat.id } });
	});
	router.post("/channels/:id/chats/:chatId/takeover", async (req, res) => {
		requestBody(req.body ?? {}, []);
		const channel = positiveResourceId(req.params["id"]),
			chat = positiveResourceId(req.params["chatId"]);
		await service.requireChannel(req.session, channel);
		res.json({
			data: await takeover(req.session.instance, chat, req.session.userId, undefined, channel, async (tx) => {
				await service.requireChannel(req.session, channel, tx);
			})
		});
	});
	const readinessError: express.ErrorRequestHandler = (error, _req, res, next) => {
		if (error instanceof TriageNotPrepared || unavailableDatabase(error)) {
			res.status(503).json({ message: readinessMessage });
			return;
		}
		next(error);
	};
	router.use(readinessError);
	return router;
}
