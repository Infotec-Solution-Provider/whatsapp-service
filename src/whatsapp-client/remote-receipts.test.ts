import assert from "node:assert/strict";

async function main(): Promise<void> {
	const stub = (path: string, exports: unknown) => {
		const id = require.resolve(path);
		require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
	};
	stub("dotenv/config", {});
	for (const path of ["message-queue", "messages-distribution", "contacts", "internal-chats", "parameters", "message-reactions", "socket"]) {
		stub(`../services/${path}.service`, { __esModule: true, default: {} });
	}
	let rows: any[] = [{ id: 1, status: "SENT", chatId: null }];
	let query: any;
	let failure: Error | null = null;
	let writes = 0;
	stub("../services/prisma.service", { __esModule: true, default: { wppMessage: {
		findMany: async (args: unknown) => { query = args; return rows; }
	} } });
	stub("../services/messages.service", { __esModule: true, default: {
		updateMessage: async () => { if (failure) throw failure; writes++; return rows[0]; }
	} });
	const Client = (require("./remote-whatsapp-client") as typeof import("./remote-whatsapp-client")).default;
	const client = Object.assign(Object.create(Client.prototype), { id: 2, instance: "test-tenant" }) as InstanceType<typeof Client>;
	failure = new Error("P2024");
	await assert.rejects(client.handleMessageStatus("synthetic-stanza", "READ"), /P2024/);
	assert.deepEqual(query.where, { wwebjsIdStanza: "synthetic-stanza", clientId: 2, instance: "test-tenant" });
	assert.equal(query.take, 2);
	failure = null;
	await client.handleMessageStatus("synthetic-stanza", "READ");
	assert.equal(writes, 1);
	rows = [{ id: 1, status: "READ", chatId: null }];
	await client.handleMessageStatus("synthetic-stanza", "RECEIVED");
	assert.equal(writes, 1);
	rows = [];
	await assert.rejects(client.handleMessageStatus("synthetic-stanza", "READ"), /MESSAGE_NOT_FOUND/);
	rows = [{ id: 1 }, { id: 2 }];
	await assert.rejects(client.handleMessageStatus("synthetic-stanza", "READ"), /AMBIGUOUS_MESSAGE/);
	assert.equal(writes, 1);
	console.log("Real REMOTE handler propagates DB errors, rejects missing/ambiguous IDs, isolates tenant/client, preserves READ");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
