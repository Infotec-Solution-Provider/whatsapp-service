import "express-async-errors";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { MESSAGE_FLOW_EDITOR_PARAMETER } from "../parameters/message-flow-editor";
import { currentDatabaseTenant } from "../utils/database-tenant-context";

test("studio routes require a session, administrator and instance flag before accessing sector data", async () => {
	const calls: unknown[][] = [];
	const cache = new Map<string, NodeModule | undefined>();
	function stub(path: string, exports: object) {
		const id = require.resolve(path);
		cache.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports } } as NodeModule;
	}
	stub("../services/auth.service", { default: { async fetchSessionData(token: string) {
		return { instance: token === "disabled" ? "tenant-b" : "tenant-a", role: token === "operator" ? "ACTIVE" : "ADMIN" };
	} } });
	stub("../services/prisma.service", { default: { parameter: { async findFirst({ where }: { where: Record<string, unknown> }) {
		assert.deepEqual(where, { instance: currentDatabaseTenant(), key: MESSAGE_FLOW_EDITOR_PARAMETER, scope: "INSTANCE", userId: null, sectorId: null });
		return where["instance"] === "tenant-a" ? { value: "true" } : null;
	} } } });
	class StudioError extends Error {
		constructor(public status: number, public code: string, message: string) { super(message); }
	}
	function capture(...args: unknown[]) {
		assert.equal(args[0], currentDatabaseTenant());
		calls.push(args);
		return { valid: true, errors: [] };
	}
	stub("../services/message-flow-studio.service", { StudioError, default: {
		list: capture, create: capture, update: capture, duplicate: capture, activate: capture, validate: capture
	} });
	stub("../message-flow/simulation", { FlowSimulationError: class extends Error {}, simulateMessageFlow: capture });
	const { default: router } = require("./message-flow-studio.controller") as typeof import("./message-flow-studio.controller");
	const server = express().use("/studio", router).listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/studio/sectors/";
	try {
		for (const [method, path] of [["GET", "flows"], ["POST", "flows"], ["PUT", "flows/2"], ["POST", "flows/2/activate"],
			["POST", "flows/2/duplicate"], ["POST", "validate"], ["POST", "simulate"]] as const) {
			for (const [token, status] of [["", 401], ["operator", 403], ["disabled", 403]] as const) {
				const response = await fetch(base + "7/" + path, { method, headers: token ? { Authorization: token } : {} });
				assert.equal(response.status, status);
			}
		}
		assert.equal(calls.length, 0);
		const get = (url: string) => fetch(base + url, { headers: { Authorization: "admin" } });
		assert.equal((await get("oops/flows")).status, 400);
		assert.equal((await get("7/flows?instance=tenant-b")).status, 200);
		assert.deepEqual(calls, [["tenant-a", 7]]);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		for (const [id, previous] of cache) {
			if (previous) require.cache[id] = previous;
			else delete require.cache[id];
		}
	}
});
