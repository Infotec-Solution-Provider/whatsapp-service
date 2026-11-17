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
	let groupEventQuery: any;
	let groupMessageQuery: any;
	let groupEvent: { id: string } | null = null;
	let groupMessage: { id: number } | null = null;
	let failure: Error | null = null;
	let writes = 0;
	stub("../services/prisma.service", { __esModule: true, default: {
		wppMessage: { findMany: async (args: unknown) => { query = args; return rows; } },
		remoteInboundEventInbox: {
			findFirst: async (args: unknown) => { groupEventQuery = args; return groupEvent; }
		},
		internalMessage: {
			findFirst: async (args: unknown) => { groupMessageQuery = args; return groupMessage; }
		}
	} });
	stub("../services/messages.service", { __esModule: true, default: {
		updateMessage: async () => { if (failure) throw failure; writes++; return rows[0]; }
	} });
	const Client = (require("./remote-whatsapp-client") as typeof import("./remote-whatsapp-client")).default;
	const client = Object.assign(Object.create(Client.prototype), { id: 2, instance: "test-tenant" }) as InstanceType<typeof Client>;
	failure = new Error("P2024");
	await assert.rejects(client.handleMessageStatus("synthetic-stanza", "READ"), /P2024/);
	assert.deepEqual(query.where, { wwebjsIdStanza: "synthetic-stanza", clientId: 2, instance: "test-tenant" });
	assert.equal(query.take, 2);
	assert.deepEqual(query.select, { id: true, status: true });
	failure = null;
	await client.handleMessageStatus("synthetic-stanza", "READ");
	assert.equal(writes, 1);
	rows = [{ id: 1, status: "READ", chatId: null }];
	await client.handleMessageStatus("synthetic-stanza", "RECEIVED");
	assert.equal(writes, 1);
	assert.equal(groupEventQuery, undefined, "A matching direct message keeps its existing status path");

	rows = [];
	await assert.rejects(client.handleMessageStatus("synthetic-stanza", "READ"), /MESSAGE_NOT_FOUND/);
	assert.deepEqual(groupEventQuery, {
		where: {
			clientId: 2, eventType: "message-received", providerMessageId: "synthetic-stanza",
			status: "COMPLETED", payload: { path: "$.message.isGroup", equals: true }
		},
		select: { id: true }
	});
	assert.deepEqual(groupMessageQuery.where, {
		clientId: 2, instance: "test-tenant",
		OR: [{ wwebjsIdStanza: "synthetic-stanza" }, { wwebjsIdStanza: null, wwebjsId: "synthetic-stanza" }]
	});
	groupMessage = { id: 4 };
	await client.handleMessageStatus("synthetic-stanza", "READ");
	await client.handleMessageStatus("synthetic-stanza", "ERROR");
	groupMessage = null;
	groupEvent = { id: "completed-group-event" };
	groupMessageQuery = undefined;
	await client.handleMessageStatus("synthetic-stanza", "READ");
	assert.equal(groupMessageQuery, undefined, "A completed group ingress identifies a group even when not synced");

	rows = [{ id: 1 }, { id: 2 }];
	await assert.rejects(client.handleMessageStatus("synthetic-stanza", "READ"), /AMBIGUOUS_MESSAGE/);
	assert.equal(writes, 1);
	console.log("PASS: direct receipt isolation and progression, group receipts acknowledged without status writes, missing and ambiguous IDs retried");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
