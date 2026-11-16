import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import fs from "node:fs";
import { assertOperatorFeature, operatorFeatureProfilePath, OperatorFeatureError } from "./rollout";

test("real HTTP auth boundary keeps reads/replays, denies nonpilot writes and requires admin for ODIM flow tools", async () => {
	assert.equal(fs.existsSync(operatorFeatureProfilePath), false);
	fs.writeFileSync(operatorFeatureProfilePath, JSON.stringify({ version: 1, instance: "odim", allowedOperatorIds: [534], effectiveAt: "2026-11-16T12:00:00.123Z", features: { operator: true, telephony: true, crm: true, whatsapp: true } }), { flag: "wx", mode: 0o600 });
	const previous = new Map<string, NodeModule | undefined>();
	const replace = (name: string, value: unknown) => { const file = require.resolve(name); previous.set(file, require.cache[file]); require.cache[file] = { id: file, filename: file, loaded: true, exports: { __esModule: true, default: value } } as NodeModule; };
	replace("../services/auth.service", { fetchSessionData: async (token: string) => {
		const [instance, user, role] = token.replace("Bearer ", "").split(":");
		return { instance, userId: Number(user), role, sectorId: 1, name: "Fixture" };
	} });
	replace("../services/prisma.service", {
		wppMessageFlow: { findUnique: async () => ({ instance: "odim" }) },
		wppMessageFlowStep: { findUnique: async () => ({ WppMessageFlow: { instance: "odim" } }) },
		wppContact: { findUnique: async () => ({ instance: "odim" }) }
	});
	const auth = require("../middlewares/is-authenticated.middleware").default as typeof import("../middlewares/is-authenticated.middleware").default;
	const { guardOdimFlowMutation } = require("../middlewares/operator-feature-flow.middleware") as typeof import("../middlewares/operator-feature-flow.middleware");
	const app = express(); app.use(express.json()); let mutations = 0;
	app.get("/api/whatsapp/chats", auth, (_req, res) => res.json({ history: true }));
	app.post("/api/whatsapp/chats", auth, (_req, res) => { mutations++; res.sendStatus(200); });
	app.post("/api/whatsapp/:clientId/messages", auth, (req, res) => {
		if (req.body.replay) { res.json({ created: false, status: "UNKNOWN" }); return; }
		try { assertOperatorFeature(req.session, "whatsapp"); mutations++; res.sendStatus(200); }
		catch (e) { const error = e as OperatorFeatureError; res.status(error.status).json({ code: error.code }); }
	});
	app.put("/api/message-flows/:id", guardOdimFlowMutation("flow"), (_req, res) => { mutations++; res.sendStatus(200); });
	app.post("/api/message-flows", guardOdimFlowMutation("flow"), (_req, res) => { mutations++; res.sendStatus(200); });
	app.put("/api/message-flows/steps/:stepId", guardOdimFlowMutation("step"), (_req, res) => { mutations++; res.sendStatus(200); });
	app.post("/api/whatsapp/flow-execution/execute", guardOdimFlowMutation("execution"), (_req, res) => { mutations++; res.sendStatus(200); });
	const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const request = (url: string, method: string, actor?: string, body = {}) => fetch(`http://127.0.0.1:${address.port}${url}`, { method, headers: { "content-type": "application/json", ...(actor ? { authorization: `Bearer ${actor}` } : {}) }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
	try {
		assert.equal((await request("/api/whatsapp/chats", "GET", "odim:535:ADMIN")).status, 200);
		for (const actor of ["odim:535:ADMIN", "ODIM:535:OPERATOR", "ódim:535:ADMIN"]) {
			const denied = await request("/api/whatsapp/chats", "POST", actor);
			assert.equal(denied.status, 403); assert.equal((await denied.json() as { code: string }).code, "OPERATOR_FEATURE_PILOT_REQUIRED");
		}
		assert.equal(mutations, 0);
		assert.equal((await request("/api/whatsapp/1/messages", "POST", "odim:535:ADMIN", { replay: true })).status, 200);
		assert.equal((await request("/api/whatsapp/1/messages", "POST", "odim:535:ADMIN")).status, 403); assert.equal(mutations, 0);
		assert.equal((await request("/api/whatsapp/chats", "POST", "odim:534:OPERATOR")).status, 200);
		for (const [url, method, body] of [["/api/message-flows/1", "PUT", {}], ["/api/message-flows/steps/1", "PUT", {}], ["/api/whatsapp/flow-execution/execute", "POST", { instance: "alpha", contactId: 1 }], ["/api/message-flows", "POST", { instance: "ODIM" }]] as const) {
			assert.equal((await request(url, method, undefined, body)).status, 401);
			assert.equal((await request(url, method, "odim:535:ADMIN", body)).status, 403);
			assert.equal((await request(url, method, "odim:534:OPERATOR", body)).status, 403);
			assert.equal((await request(url, method, "alpha:534:ADMIN", body)).status, 403);
			assert.equal((await request(url, method, "odim:534:ADMIN", body)).status, 200);
		}
		assert.equal((await request("/api/message-flows", "POST", undefined, { instance: "alpha" })).status, 200, "unrelated tenant retains the existing route contract");
	} finally {
		await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
		for (const [file, cached] of previous) if (cached) require.cache[file] = cached; else delete require.cache[file];
		fs.unlinkSync(operatorFeatureProfilePath);
	}
});
