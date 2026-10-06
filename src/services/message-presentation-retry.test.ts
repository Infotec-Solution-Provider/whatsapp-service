import assert from "node:assert/strict";
import { test } from "node:test";

test("internal hydrate attaches outcome-only resend hints to ERROR messages", async (t) => {
	const queries: Array<{ model: string; ids: number[] }> = [];
	const linkedChats = new Set([1]);
	const queueRows = new Map<number, string>();
	const previous = new Map<string, NodeModule | undefined>();
	const stub = (path: string, value: unknown) => {
		const resolved = require.resolve(path);
		previous.set(resolved, require.cache[resolved]);
		require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
	};
	stub("./message-mentions.service", { hydrate: async (_instance: string, messages: unknown[]) => messages.map(() => ({})) });
	stub("./message-reactions.service", { hydrate: async (_instance: string, messages: unknown[]) => messages });
	stub("./prisma.service", {
		operatorOutboundSend: { findMany: async () => [] },
		internalChat: {
			findMany: async ({ where }: { where: { id: { in: number[] } } }) => {
				queries.push({ model: "internalChat", ids: where.id.in });
				return where.id.in.filter((id) => linkedChats.has(id)).map((id) => ({ id }));
			}
		},
		internalMessageProcessingQueue: {
			findMany: async ({ where }: { where: { internalMessageId: { in: number[] } } }) => {
				queries.push({ model: "queue", ids: where.internalMessageId.in });
				return where.internalMessageId.in
					.filter((id) => queueRows.has(id))
					.map((id) => ({ internalMessageId: id, messageData: queueRows.get(id)! }));
			}
		}
	});
	const servicePath = require.resolve("./message-presentation.service");
	previous.set(servicePath, require.cache[servicePath]);
	delete require.cache[servicePath];
	t.after(() => {
		for (const [path, cached] of previous) {
			if (cached) require.cache[path] = cached; else delete require.cache[path];
		}
	});
	const presentation = (require("./message-presentation.service") as typeof import("./message-presentation.service")).default;
	const message = (id: number, status: string, internalChatId = 1) => ({ id, instance: "acme", status, internalChatId });

	await t.test("no ERROR message means no extra query", async () => {
		queries.length = 0;
		const result = await presentation.hydrate("acme", [message(1, "RECEIVED"), message(2, "PENDING")], "internal");
		assert.equal(queries.length, 0);
		assert.ok(result.every((item) => !("whatsappRetry" in item)));
	});

	await t.test("hint per outcome, generation and queue presence", async () => {
		queries.length = 0;
		queueRows.clear();
		queueRows.set(10, JSON.stringify({ outcome: { kind: "NOT_SENT", safeToResend: true } }));
		queueRows.set(11, JSON.stringify({ outcome: { kind: "UNKNOWN", safeToResend: false } }));
		queueRows.set(12, JSON.stringify({ retryGeneration: 3, outcome: { kind: "NOT_SENT", safeToResend: true } }));
		queueRows.set(13, "not json");
		const result = await presentation.hydrate("acme", [
			message(10, "ERROR"), message(11, "ERROR"), message(12, "ERROR"), message(13, "ERROR"),
			message(14, "ERROR"), message(15, "ERROR", 2), message(16, "RECEIVED")
		], "internal");
		const hints = Object.fromEntries(result.map((item) => [item.id, item.whatsappRetry]));
		assert.deepEqual(hints[10], { allowed: true, requiresConfirmation: false });
		assert.deepEqual(hints[11], { allowed: true, requiresConfirmation: true });
		assert.deepEqual(hints[12], { allowed: false, requiresConfirmation: false, reason: "RETRY_LIMIT" });
		assert.deepEqual(hints[13], { allowed: true, requiresConfirmation: true }, "legacy/unreadable payload is ambiguous");
		assert.deepEqual(hints[14], { allowed: false, requiresConfirmation: false, reason: "NO_QUEUE_ITEM" });
		assert.equal(hints[15], undefined, "chat without wppGroupId gets no hint");
		assert.equal(hints[16], undefined, "only ERROR messages get a hint");
		assert.deepEqual(queries.map((query) => query.model), ["internalChat", "queue"]);
	});

	await t.test("queue rows are loaded in batches of at most 100", async () => {
		queries.length = 0;
		const many = Array.from({ length: 230 }, (_, index) => message(1000 + index, "ERROR"));
		await presentation.hydrate("acme", many, "internal");
		const sizes = queries.filter((query) => query.model === "queue").map((query) => query.ids.length);
		assert.deepEqual(sizes, [100, 100, 30]);
	});

	await t.test("wpp domain never computes internal hints", async () => {
		queries.length = 0;
		await presentation.hydrate("acme", [message(10, "ERROR")], "wpp");
		assert.equal(queries.length, 0);
	});
});
