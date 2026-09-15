import assert from "node:assert/strict";
import type presentationType from "./message-presentation.service";

async function run() {
	const previous = new Map<string, NodeModule | undefined>();
	const stub = (path: string, value: unknown) => {
		const resolved = require.resolve(path);
		previous.set(resolved, require.cache[resolved]);
		require.cache[resolved] = { id: resolved, filename: resolved, loaded: true,
			exports: { __esModule: true, default: value } } as NodeModule;
	};
	const queries: unknown[] = [];
	const rows = [
		{ messageId: 1, status: "FAILED", error: "A Meta recusou a mídia (código 100)." },
		{ messageId: 2, status: "UNKNOWN", error: "Sem resposta após o envio; não reenviar automaticamente." },
		{ messageId: 3, status: "FAILED", error: "Stale refusal after confirmed delivery" },
	];
	try {
		stub("./prisma.service", { operatorOutboundSend: { findMany: async (query: unknown) => {
			queries.push(query);
			return rows;
		} } });
		stub("./message-mentions.service", { hydrate: async (_instance: string, messages: Array<{ mentionMetadata: unknown }>) =>
			messages.map((message) => ({ ...message, mentionEntities: message.mentionMetadata })) });
		stub("./message-reactions.service", { hydrate: async (_instance: string, messages: unknown[]) => messages });
		const path = require.resolve("./message-presentation.service");
		previous.set(path, require.cache[path]);
		delete require.cache[path];
		const presentation: typeof presentationType = require(path).default;
		const message = (id: number, status: string, instance = "tenant-a") => ({
			id, status, instance, mentionMetadata: [],
		});
		const failure = message(1, "ERROR");
		assert.equal(presentation.fromStored(failure, rows[0]).sendError, rows[0]!.error);
		assert.equal(presentation.fromStored(message(2, "UNKNOWN"), rows[1]).sendError, rows[1]!.error);
		assert.equal(presentation.fromStored(message(3, "SENT"), rows[2]).sendError, undefined);
		assert.equal(presentation.fromStored(failure, rows[1]).sendError, undefined);
		assert.equal(presentation.fromStored(failure, { status: "FAILED", error: "x".repeat(5_000) }).sendError?.length, 4_000);
		assert.equal(queries.length, 0, "lookup/replay already carries the attempt and must not query again");

		await presentation.hydrate("tenant-a", [message(3, "SENT"), message(4, "PENDING"), message(5, "READ")]);
		await presentation.hydrate("tenant-a", [failure], "internal");
		await presentation.hydrate("tenant-a", [message(9, "ERROR", "tenant-b")]);
		assert.equal(queries.length, 0, "normal, internal and other-tenant messages must not query attempts");
		const result = await presentation.hydrate("tenant-a", [failure, message(2, "UNKNOWN"), message(3, "SENT")]);
		assert.equal(queries.length, 1, "history/socket enrichment performs one bounded batch");
		assert.deepEqual(queries[0], {
			where: { instance: "tenant-a", messageId: { in: [1, 2] }, status: { in: ["FAILED", "UNKNOWN"] } },
			select: { messageId: true, status: true, error: true },
		});
		assert.equal(result[0]!.sendError, rows[0]!.error);
		assert.equal(result[1]!.sendError, rows[1]!.error);
		assert.equal(result[2]!.sendError, undefined, "a stale rejection cannot mark a confirmed message failed");
		assert.deepEqual(result[0]!.mentionEntities, []);
		assert.equal("mentionMetadata" in result[0]!, false);
		assert.equal("error" in result[0]!, false, "only the diagnostic is exposed, never job internals");
		console.log("message-send-error-presentation: scoped batching, no-query success, receipt reasons and confirmed ACK protection passed");
	} finally {
		for (const [path, cached] of previous) {
			if (cached) require.cache[path] = cached;
			else delete require.cache[path];
		}
	}
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
