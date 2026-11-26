import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { currentDatabaseTenant } from "../utils/database-tenant-context";

async function main() {
	const auth = require.resolve("../services/auth.service");
	const report = require.resolve("../services/active-users-report.service");
	const calls: string[] = [];
	require.cache[auth] = { exports: { __esModule: true, default: { fetchSessionData: async (token: string) => {
		if (token === "Bearer bad") throw new Error("invalid");
		return { instance: token === "Bearer b" ? "b" : "a", role: token === "Bearer user" ? "USER" : "ADMIN" };
	} } } } as NodeModule;
	require.cache[report] = { exports: { activeUsersReport: async (instance: string) => {
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(currentDatabaseTenant(), instance);
		calls.push(instance);
		return { users: [{ name: instance }] };
	} } } as NodeModule;
	const { createActiveUsersReportRouter } = require("./active-users-report.controller") as typeof import("./active-users-report.controller");
	const app = express(); app.use(createActiveUsersReportRouter());
	const server = app.listen(0, "127.0.0.1");
	try {
		await once(server, "listening");
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/whatsapp/reports/active-users`;
		const get = (token?: string, instance?: string) => fetch(url, { headers: { ...(token ? { Authorization: token } : {}), ...(instance ? { "X-CRM-Instance": instance } : {}) } });
		assert.equal((await get()).status, 401);
		assert.equal((await get("Bearer bad")).status, 401);
		assert.equal((await get("Bearer user")).status, 403);
		assert.equal((await get("Bearer a", "b")).status, 409);
		const responses = await Promise.all([get("Bearer a", "a"), get("Bearer b", "b")]);
		assert.deepEqual(responses.map(response => response.status), [200, 200]);
		assert.equal(responses[0]!.headers.get("cache-control"), "no-store");
		assert.deepEqual(calls.sort(), ["a", "b"]);
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
