import "express-async-errors";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express, { type RequestHandler } from "express";
import { businessChannelUrl, remoteControlBase } from "../utils/remote-control-host";

test("management and call endpoints resolve a tenant channel, peer and operator on the server", async t => {
	const forwarded: Array<{ url: string; owner?: string; body: unknown }> = [];
	const host = express().use(express.json()).use((req, res) => {
		if (req.path.startsWith("/api/internal/whatsapp-calls/")) {
			assert.equal(req.get("x-whatsapp-calls-instance"), "acme");
			assert.equal(req.get("x-whatsapp-calls-client-id"), "7");
			assert.equal(req.get("x-whatsapp-calls-key"), "k".repeat(32));
			assert.equal(req.query["peerJid"], "5551999999999@s.whatsapp.net");
		} else {
			assert.equal(req.query["instance"], "acme");
			assert.equal(req.get("authorization"), "Bearer " + "m".repeat(32));
			assert.equal(req.get("x-whatsapp-actor-id"), "11");
		}
		const owner = req.get("x-whatsapp-calls-owner");
		forwarded.push({ url: req.path, ...(owner ? { owner } : {}), body: req.body });
		res.json({ ok: true });
	}).listen(0, "127.0.0.1");
	await once(host, "listening");
	t.after(() => host.close());
	const hostBase = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
	const env = { WWEBJS_CONTROL_HOSTS: hostBase, WHATSAPP_CALLS_INTERNAL_KEY: "k".repeat(32), WWEBJS_SESSION_MANAGEMENT_TOKEN: "m".repeat(32) };
	for (const [key, value] of Object.entries(env)) {
		const old = process.env[key];
		process.env[key] = value;
		t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
	}
	assert.equal(remoteControlBase(hostBase + "/sessions/physical"), hostBase);
	assert.equal(remoteControlBase(hostBase + "/another-service"), null);
	assert.equal(businessChannelUrl(hostBase + "/sessions/old", "acme", 7), hostBase + "/channels/acme/7");
	assert.equal(businessChannelUrl("https://legacy.invalid", "acme", 7), "https://legacy.invalid");

	const stub = (name: string, value: unknown) => {
		const filename = require.resolve(name);
		const previous = require.cache[filename];
		require.cache[filename] = { exports: { __esModule: true, default: value }, loaded: true } as NodeModule;
		t.after(() => { if (previous) require.cache[filename] = previous; else delete require.cache[filename]; });
	};
	const authenticate: RequestHandler = (req, res, next) => {
		const role = req.get("authorization");
		if (!role) { res.sendStatus(401); return; }
		req.session = { userId: 11, sectorId: 2, instance: "acme", name: "Operador", role };
		next();
	};
	stub("../middlewares/is-authenticated.middleware", authenticate);
	stub("../middlewares/require-session-monitoring.middleware", ((_req, _res, next) => next()) as RequestHandler);
	let assigned = true;
	stub("../services/prisma.service", {
		wppClient: { findFirst: async ({ where }: { where: { id: number; instance: string; type: string; isActive: boolean } }) => {
			assert.equal(where.instance, "acme"); assert.equal(where.type, "REMOTE"); assert.equal(where.isActive, true);
			return where.id === 7 ? { remoteClientUrl: hostBase + "/sessions/old", phone: "5551888888888" } : null;
		} },
		wppChat: { findFirst: async ({ where }: { where: unknown }) => {
			assert.deepEqual(where, { id: 5, instance: "acme", isFinished: false, userId: 11 });
			return assigned ? { contact: { instance: "acme", phone: "5551999999999" }, sector: { defaultClientId: 8 } } : null;
		} },
		wppMessage: { findFirst: async () => ({ clientId: 7 }) }
	});
	const router = (require("./whatsapp-control.controller") as typeof import("./whatsapp-control.controller")).default;
	const server = express().use(router).use(((err, _req, res, _next) =>
		res.status(err.statusCode ?? 403).json({ message: "Denied" })) as express.ErrorRequestHandler).listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => server.close());
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/whatsapp`;
	const admin = { authorization: "ADMIN", "Content-Type": "application/json" };
	const topology = base + "/session-monitor/clients/7/topology";
	assert.equal((await fetch(topology)).status, 401);
	assert.equal((await fetch(topology, { headers: { authorization: "USER" } })).ok, false);
	assert.equal(forwarded.length, 0);
	assert.equal((await fetch(topology + "/group", { method: "PUT", headers: admin, body: JSON.stringify({ expectedPhone: "123" }) })).status, 409);
	assert.equal((await fetch(topology + "/shadows", { method: "POST", headers: admin, body: JSON.stringify({ library: "WHATSMEOW", instance: "other" }) })).status, 201);
	assert.deepEqual(forwarded.at(-1)?.body, { library: "WHATSMEOW" });
	const headers = { ...admin, authorization: "USER", "x-whatsapp-call-tab": randomUUID() };
	const calls = base + "/chats/5/calls";
	assert.equal((await fetch(calls + "/start", { method: "POST", headers, body: JSON.stringify({ video: false, peerJid: "other", clientId: 9 }) })).status, 200);
	assert.deepEqual(forwarded.at(-1)?.body, { video: false, peerJid: "5551999999999@s.whatsapp.net" });
	const firstOwner = forwarded.at(-1)?.owner;
	assert.ok(firstOwner);
	await fetch(calls, { headers: { ...headers, "x-whatsapp-call-tab": randomUUID() } });
	assert.notEqual(forwarded.at(-1)?.owner, firstOwner);
	const previousCount = forwarded.length;
	assigned = false;
	assert.equal((await fetch(calls + "/abc/end", { method: "POST", headers })).status, 404);
	assert.equal(forwarded.length, previousCount);
});
