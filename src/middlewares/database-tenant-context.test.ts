import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { currentDatabaseTenant } from "../utils/database-tenant-context";

async function main() {
	const authPath = require.resolve("../services/auth.service");
	const previous = require.cache[authPath];
	require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
		__esModule: true,
		default: { fetchSessionData: async (token: string) => ({ instance: token === "test-token-a" ? "tenant-a" : "tenant-b" }) },
	} } as NodeModule;
	const isAuthenticated = (require("./is-authenticated.middleware") as typeof import("./is-authenticated.middleware")).default;
	const app = express();
	let arrived = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	app.get("/test", isAuthenticated, async (_req, res) => {
		if (++arrived === 2) release();
		await gate;
		res.json({ tenant: currentDatabaseTenant() });
	});
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/test`;
	try {
		assert.equal((await fetch(url)).status, 401);
		const responses = await Promise.all(["test-token-a", "test-token-b"].map(async (token) => {
			const response = await fetch(url, { headers: { authorization: token }, signal: AbortSignal.timeout(5_000) });
			assert.equal(response.status, 200);
			return response.json();
		}));
		assert.deepEqual(responses, [{ tenant: "tenant-a" }, { tenant: "tenant-b" }]);
		assert.equal(currentDatabaseTenant(), null);
		console.log("database tenant context: actual authenticated HTTP middleware isolates concurrent tenants");
	} finally {
		release();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		if (previous) require.cache[authPath] = previous;
		else delete require.cache[authPath];
	}
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
