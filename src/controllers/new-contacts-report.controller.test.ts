import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import "express-async-errors";
import { handleRequestError } from "@rgranatodutra/http-errors";
import type { AddressInfo } from "node:net";
import type { NewContactsQuery } from "../services/new-contacts-report.contract";
import { currentDatabaseTenant } from "../utils/database-tenant-context";

test("isolates concurrent administrator requests by authenticated tenant", async () => {
	const authModule = require.resolve("../services/auth.service");
	const reportModule = require.resolve("../services/new-contacts-report.service");
	const authOriginal = require.cache[authModule];
	const reportOriginal = require.cache[reportModule];
	const routeModule = require.resolve("./new-contacts-report.controller");
	const routeOriginal = require.cache[routeModule];
	const authMiddleware = require.resolve("../middlewares/is-authenticated.middleware");
	const authMiddlewareOriginal = require.cache[authMiddleware];
	const calls: string[] = [];
	const sessions = new Map([
		["Bearer permitted", { instance: "suprimaxxi", role: "ADMIN" }],
		["Bearer another-tenant", { instance: "homolog", role: "admin" }],
		["Bearer operator", { instance: "homolog", role: "USER" }],
		["Bearer invalid-tenant", { instance: "", role: "ADMIN" }]
	]);

	require.cache[authModule] = {
		exports: { __esModule: true, default: { fetchSessionData: async (token: string) => ({
			...sessions.get(token), userId: 11
		}) } }
	} as NodeModule;
	require.cache[reportModule] = { exports: { queryNewContactsReport: async (instance: string, query: NewContactsQuery) => {
		calls.push(instance);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(currentDatabaseTenant(), instance);
		assert.equal(query.from.toISOString(), "2026-11-24T03:00:00.000Z");
		return { rows: [{ contactId: 1, contactName: instance }], total: 1, byOwner: [], queriedAt: new Date(0).toISOString() };
	} } } as NodeModule;
	const { createNewContactsReportRouter } = require(routeModule) as typeof import("./new-contacts-report.controller");
	const app = express();
	app.use(express.json());
	app.use(createNewContactsReportRouter());
	app.use(handleRequestError as unknown as express.ErrorRequestHandler);
	const server = app.listen(0, "127.0.0.1");
	try {
		await once(server, "listening");
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/whatsapp/reports/new-contacts/query`;
		const filters = { from: "2026-11-24", to: "2026-11-24" };
		const post = (authorization?: string, body: unknown = { filters }, instance?: string) => fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(authorization && { Authorization: authorization }),
				...(instance !== undefined && { "X-CRM-Instance": instance })
			},
			body: JSON.stringify(body)
		});
		assert.equal((await post()).status, 401);
		assert.equal((await post("Bearer operator")).status, 403);
		assert.equal((await post("Bearer invalid-tenant")).status, 403);
		assert.equal((await post("Bearer permitted", { filters, instance: "homolog" })).status, 400);
		const mismatch = await post("Bearer another-tenant", { filters }, "Suprimaxxi");
		assert.equal(mismatch.status, 409);
		assert.equal((await mismatch.json()).code, "CRM_INSTANCE_CHANGED");
		assert.deepEqual(calls, []);

		const responses = await Promise.all([
			post("Bearer permitted", { filters }, "Suprimaxxi"),
			post("Bearer another-tenant")
		]);
		for (const response of responses) {
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("cache-control"), "no-store");
		}
		const [first, second] = await Promise.all(responses.map(response => response.json()));
		assert.deepEqual(first.data.rows, [{ contactId: 1, contactName: "suprimaxxi" }]);
		assert.deepEqual(second.data.rows, [{ contactId: 1, contactName: "homolog" }]);
		assert.deepEqual(calls.sort(), ["homolog", "suprimaxxi"]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		for (const [path, original] of [
			[authModule, authOriginal], [reportModule, reportOriginal],
			[routeModule, routeOriginal], [authMiddleware, authMiddlewareOriginal]
		] as const) {
			if (original) require.cache[path] = original;
			else delete require.cache[path];
		}
	}
});
