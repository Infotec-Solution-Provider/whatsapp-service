import "express-async-errors";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import type { Request, Response, NextFunction } from "express";

let reads = 0;
const saved = new Map<string, NodeModule | undefined>();
function stub(modulePath: string, value: unknown) {
	const file = require.resolve(modulePath); saved.set(file, require.cache[file]);
	require.cache[file] = { id: file, filename: file, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
}
stub("../middlewares/is-authenticated.middleware", (req: Request, res: Response, next: NextFunction) => {
	if (req.headers.authorization !== "Bearer fixture") { res.status(401).json({ message: "Unauthorized" }); return; }
	req.session = { instance: "fixture-a", userId: 7, sectorId: 3, role: "ATIVO", name: "Fixture" }; next();
});
stub("../services/wallets.service", { getUserWallets: async (session: { instance: string }, userId: unknown) => { reads++; return [{ instance: session.instance, requestedUser: userId }]; } });
const controller = (require("./wallets.controller") as typeof import("./wallets.controller")).default;
for (const [file, previous] of saved) { if (previous) require.cache[file] = previous; else delete require.cache[file]; }

test("wallet route requires authentication and refuses a query-selected tenant before service", async () => {
	const app = express(); app.use(controller.router);
	app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => res.status(400).json({ message: error.message }));
	const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
	try {
		const address = server.address() as { port: number };
		const url = `http://127.0.0.1:${address.port}/api/wallets`;
		assert.equal((await fetch(`${url}?instance=fixture-b&userId=99`)).status, 401); assert.equal(reads, 0);
		assert.equal((await fetch(`${url}?instance=fixture-b`, { headers: { Authorization: "Bearer fixture" } })).status, 400); assert.equal(reads, 0);
		const valid = await fetch(url, { headers: { Authorization: "Bearer fixture" } }); assert.equal(valid.status, 200);
		const body = await valid.json() as { data: Array<{ instance: string }> };
		assert.equal(body.data[0]?.instance, "fixture-a"); assert.equal(reads, 1);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
