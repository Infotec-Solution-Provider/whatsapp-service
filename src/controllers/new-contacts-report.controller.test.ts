import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import "express-async-errors";
import { handleRequestError } from "@rgranatodutra/http-errors";
import type { AddressInfo } from "node:net";
import type { NewContactsQuery } from "../services/new-contacts-report.contract";
import { currentDatabaseTenant } from "../utils/database-tenant-context";

test("authenticates the endpoint and derives the database tenant from the session", async () => {
	const authModule = require.resolve("../services/auth.service");
	const reportModule = require.resolve("../services/new-contacts-report.service");
	const authOriginal = require.cache[authModule];
	const reportOriginal = require.cache[reportModule];
	const routeModule = require.resolve("./new-contacts-report.controller");
	const routeOriginal = require.cache[routeModule];
	const authMiddleware = require.resolve("../middlewares/is-authenticated.middleware");
	const authMiddlewareOriginal = require.cache[authMiddleware];
	let calls = 0;

	require.cache[authModule] = {
		exports: { __esModule: true, default: { fetchSessionData: async (token: string) => ({
			instance: token === "Bearer another-tenant" ? "odim" : "Suprimaxxi",
			role: token === "Bearer operator" ? "USER" : "ADMIN",
			userId: 11
		}) } }
	} as NodeModule;
	require.cache[reportModule] = { exports: { queryNewContactsReport: async (instance: string, query: NewContactsQuery) => {
		calls++;
		assert.equal(instance, "suprimaxxi");
		assert.equal(currentDatabaseTenant(), "suprimaxxi");
		assert.equal(query.from.toISOString(), "2026-11-24T03:00:00.000Z");
		return { rows: [], total: 0, byOwner: [], queriedAt: new Date(0).toISOString(), page: query.page, pageSize: query.pageSize };
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
		const post = (authorization?: string, body: unknown = { filters }) => fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(authorization && { Authorization: authorization }) },
			body: JSON.stringify(body)
		});
		assert.equal((await post()).status, 401);
		assert.equal((await post("Bearer operator")).status, 403);
		assert.equal((await post("Bearer another-tenant")).status, 403);
		assert.equal((await post("Bearer permitted", { filters, instance: "odim" })).status, 400);
		assert.equal(calls, 0);
		const response = await post("Bearer permitted");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal((await response.json()).data.total, 0);
		assert.equal(calls, 1);
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
