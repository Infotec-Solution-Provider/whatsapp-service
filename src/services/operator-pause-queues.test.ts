import assert from "node:assert/strict";
import test from "node:test";
import { OperatorPauseAdmissionError } from "./operator-pause-admission";

const saved = new Map<string, NodeModule | undefined>();
function stub(path: string, value: unknown) {
	const id = require.resolve(path); saved.set(id, require.cache[id]);
	require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
}
const updates: Array<{ sql?: string; values?: unknown[]; where?: Record<string, unknown>; data?: Record<string, unknown> }> = [];
let calls = 0;
const rejectPaused = async () => { calls++; throw new OperatorPauseAdmissionError("OPERATOR_PAUSED"); };
const item = { id: "fixture", instance: "test", messageId: 1, clientId: 1, contactPhone: "SYNTHETIC", status: "PROCESSING", lockedBy: "", retryCount: 3, maxRetries: 3 };
const db = {
	wppMessage: { findUnique: async () => ({ id: 1 }) },
	wppMessageProcessingQueue: {
		findUnique: async () => ({ ...item }),
		updateMany: async (change: { where: Record<string, unknown>; data: Record<string, unknown> }) => { updates.push(change); return { count: 1 }; }
	},
	gupshupWebhookQueue: {
		update: async () => ({ ...item }),
		updateMany: async (change: { where: Record<string, unknown>; data: Record<string, unknown> }) => { updates.push(change); return { count: 1 }; }
	},
	$executeRawUnsafe: async (sql: string, ...values: unknown[]) => { updates.push({ sql, values }); return 1; }
};
stub("./prisma.service", db);
stub("./waba.service", { handleWebhookEntry: rejectPaused });
stub("./gupshup.service", { handleWebhookEntry: rejectPaused });
stub("../utils/processing-logger", class { log() {} failed() {} success() {} });
const inbound = require("./message-queue.service").default as {
	workerId: string; setProcessHandler(handler: { processMessage: () => Promise<never> }): void;
	processQueueItem(value: typeof item): Promise<void>;
};
const waba = require("./waba-webhook-queue.service").default as {
	markAsProcessingAndGet(id: string): Promise<unknown>; processItem(id: string): Promise<void>;
};
const gupshup = require("./gupshup-webhook-queue.service").default as { processItem(id: string): Promise<void> };
for (const [id, previous] of saved) { if (previous) require.cache[id] = previous; else delete require.cache[id]; }

test("inbound distribution waits for a paused operator without exhausting retries", async () => {
	updates.length = 0; calls = 0; item.lockedBy = inbound.workerId;
	inbound.setProcessHandler({ processMessage: rejectPaused });
	await inbound.processQueueItem(item);
	assert.equal(calls, 1); assert.equal(updates.length, 1);
	const update = updates[0]!;
	assert.equal(update.where!["lockedBy"], inbound.workerId);
	assert.equal(update.data!["status"], "PENDING");
	assert.equal(update.data!["error"], "OPERATOR_PAUSED");
	assert.equal(update.data!["retryCount"], undefined);
	assert.ok((update.data!["lockedUntil"] as Date).getTime() >= Date.now() + 29_000);
});
test("WABA keeps a deferred webhook durable without consuming retries or claiming delivery", async () => {
	updates.length = 0; calls = 0;
	waba.markAsProcessingAndGet = async () => ({ ...item, payload: {} });
	await waba.processItem(item.id);
	assert.equal(calls, 1); assert.equal(updates.length, 1);
	assert.match(updates[0]!.sql!, /status='PENDING'/);
	assert.doesNotMatch(updates[0]!.sql!, /retry_count\s*=/);
	assert.match(updates[0]!.sql!, /AND status='PROCESSING'/);
	assert.deepEqual(updates[0]!.values, ["OPERATOR_PAUSED", item.id]);
});
test("Gupshup preserves a paused webhook even at its old retry limit", async () => {
	updates.length = 0; calls = 0;
	await gupshup.processItem(item.id);
	assert.equal(calls, 1); assert.equal(updates.length, 1);
	assert.deepEqual(updates[0]!.where, { id: item.id, status: "PROCESSING" });
	assert.equal(updates[0]!.data!["status"], "PENDING");
	assert.equal(updates[0]!.data!["retryCount"], undefined);
	assert.equal(updates[0]!.data!["processedAt"], null);
});
