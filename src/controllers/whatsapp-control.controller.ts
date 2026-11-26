import { Router, json, type ErrorRequestHandler, type Request, type Response } from "express";
import isAdmin from "../middlewares/is-admin.middleware";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import requireSessionMonitoring from "../middlewares/require-session-monitoring.middleware";
import { manageChannel, operateChatCall, WhatsAppControlError, type CallAction } from "../services/whatsapp-control.service";
import { parsePositiveInt } from "../utils/chat-scope";

const router = Router();
const topology = Router({ mergeParams: true });
const calls = Router({ mergeParams: true });
const badRequest = () => new WhatsAppControlError(400, "Parâmetros inválidos.");
const id = (req: Request, field: string) => {
	const value = parsePositiveInt(req.params[field]);
	if (!value) throw badRequest();
	return value;
};
const segment = (req: Request, field: string) => {
	const value = req.params[field];
	if (typeof value !== "string" || !value || value.length > 160 || /[\/\\\x00-\x1f]/.test(value) || value === "." || value === "..") throw badRequest();
	return value;
};

topology.use(isAuthenticated, isAdmin, requireSessionMonitoring, json({ limit: "4kb" }));
topology.get("/", async (req, res) => {
	res.json(await manageChannel(req.session, id(req, "clientId"), "get", ""));
});
for (const [method, operation, status] of [
	["put", "group", 200], ["put", "delivery", 200], ["post", "primary", 201], ["post", "shadows", 201], ["post", "promote", 200]
] as const) {
	topology[method](`/${operation}`, async (req, res) => {
		const { expectedPhone, library, sessionId, expectedPrimarySessionId, enabled } = req.body ?? {};
		let body: object;
		switch (operation) {
			case "group": body = { expectedPhone }; break;
			case "delivery":
				if (typeof enabled !== "boolean" || typeof expectedPrimarySessionId !== "string" || !expectedPrimarySessionId) throw badRequest();
				body = { enabled, expectedPrimarySessionId }; break;
			case "primary": body = { expectedPhone, library }; break;
			case "shadows": body = { library }; break;
			case "promote": body = { sessionId, expectedPrimarySessionId }; break;
		}
		res.status(status).json(await manageChannel(req.session, id(req, "clientId"), method, "/" + operation, body));
	});
}
for (const operation of ["qr", "reset-qr", "restart", "disable"] as const) {
	const method = operation === "qr" ? "get" : "post";
	topology[method](`/sessions/:sessionId/${operation}`, async (req, res) => {
		if (operation === "reset-qr" && req.body?.confirm !== true) throw badRequest();
		const suffix = `/sessions/${encodeURIComponent(segment(req, "sessionId"))}/${operation}`;
		const body = operation === "reset-qr" ? { confirm: true } : undefined;
		res.json(await manageChannel(req.session, id(req, "clientId"), method, suffix, body));
	});
}
router.use("/api/whatsapp/session-monitor/clients/:clientId/topology", topology);

calls.use(isAuthenticated, json({ limit: "128kb" }));
const handle = (action: CallAction) => async (req: Request, res: Response) => {
	const tab = req.get("x-whatsapp-call-tab") ?? "";
	if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(tab)) throw badRequest();
	const cursor = req.query["after"] ?? "0";
	if (typeof cursor !== "string" || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw badRequest();
	let body: { video: boolean } | { event: string } | undefined;
	if (action === "start") {
		if (typeof req.body?.video !== "boolean") throw badRequest();
		body = { video: req.body.video };
	} else if (action === "media") {
		if (typeof req.body?.event !== "string" || !req.body.event) throw badRequest();
		body = { event: req.body.event };
	}
	const callId = req.params["callId"] ? segment(req, "callId") : "";
	const result = await operateChatCall(req.session, id(req, "chatId"), tab, action, callId, Number(cursor), body);
	if (action === "media") res.sendStatus(204);
	else res.json(result);
};
calls.get("/", handle("snapshot"));
calls.post("/start", handle("start"));
for (const action of ["accept", "reject", "end", "media"] as const) calls.post(`/:callId/${action}`, handle(action));
router.use("/api/whatsapp/chats/:chatId/calls", calls);

const controlError: ErrorRequestHandler = (error, _req, res, next) => {
	if (error instanceof WhatsAppControlError) res.status(error.status).json({ message: error.message });
	else next(error);
};
router.use(controlError);
export default router;
