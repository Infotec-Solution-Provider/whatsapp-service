import assert from "node:assert/strict";

async function main(): Promise<void> {
	const stub = (path: string, exports: unknown) => {
		const id = require.resolve(path);
		require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
	};
	let handler!: (req: any, res: any) => Promise<void>;
	stub("express", { Router: () => ({ post: (_path: unknown, callback: typeof handler) => { handler = callback; } }) });
	stub("@in.pulse-crm/utils", { Logger: { info() {}, error() {} } });
	let result: unknown = { status: "PENDING", id: "durable-item", created: true };
	let error: Error | null = null;
	stub("../services/remote-client.service", { __esModule: true, default: {
		handleEventReceived: async () => { if (error) throw error; return result; }
	} });
	stub("../services/prisma.service", { __esModule: true, default: {} });
	require("./remote-client.controller");
	let code = 0;
	let body: any;
	const response = { status(value: number) { code = value; return this; }, json(value: unknown) { body = value; }, send(value: unknown) { body = value; } };
	const request = { params: { clientId: "2" }, body: { type: "message-status-received" }, get: () => undefined };
	await handler(request, response);
	assert.equal(code, 202);
	assert.equal(body.accepted, true);
	assert.equal(body.inboxId, "durable-item");
	result = { status: "COMPLETED", id: "durable-item", created: false };
	await handler(request, response);
	assert.equal(code, 200);
	error = new Error("P2024");
	await handler(request, response);
	assert.equal(code, 500);
	console.log("HTTP 202 for durable pending receipt, 200 only when completed, 500 on DB rejection");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
