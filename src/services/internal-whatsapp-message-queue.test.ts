import assert from "node:assert/strict";
import { test } from "node:test";
import type { InternalWhatsappQueueProcessResult } from "./internal-whatsapp-message-queue.service";

type Row = {
	id: string; status: string; createdAt: Date; processingStartedAt: Date | null; processedAt: Date | null;
	lockedUntil: Date | null; lockedBy: string | null; retryCount: number; error: string | null; messageData: string;
	internalMessageId: number;
};

test("processingStartedAt keeps the FIRST claim across polls, retries and restart recovery", async (t) => {
	const rows = new Map<string, Row>();
	const resolved = require.resolve("./prisma.service");
	const previous = require.cache[resolved];
	const servicePath = require.resolve("./internal-whatsapp-message-queue.service");
	const previousService = require.cache[servicePath];
	const pick = (where: Record<string, unknown>) => [...rows.values()].filter((row) => {
		if (where["id"] && row.id !== where["id"]) return false;
		const status = where["status"] as string | { in: string[] } | undefined;
		if (typeof status === "string" && row.status !== status) return false;
		if (status && typeof status === "object" && !status.in.includes(row.status)) return false;
		if (typeof where["messageData"] === "string" && row.messageData !== where["messageData"]) return false;
		return true;
	});
	require.cache[resolved] = {
		id: resolved, filename: resolved, loaded: true,
		exports: {
			__esModule: true,
			default: {
				internalMessageProcessingQueue: {
					findFirst: async ({ where }: { where: Record<string, unknown> }) =>
						pick(where).find((row) => !row.lockedUntil || row.lockedUntil.getTime() < Date.now()) ?? null,
					updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
						const matched = pick(where);
						for (const row of matched) Object.assign(row, data);
						return { count: matched.length };
					},
					update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
						const row = rows.get(where.id)!;
						const patch = { ...data };
						if (patch["retryCount"] && typeof patch["retryCount"] === "object") {
							row.retryCount += 1;
							delete patch["retryCount"];
						}
						Object.assign(row, patch);
						return row;
					},
					deleteMany: async () => ({ count: 0 })
				}
			}
		}
	} as NodeModule;
	delete require.cache[servicePath];
	t.after(() => {
		if (previous) require.cache[resolved] = previous; else delete require.cache[resolved];
		if (previousService) require.cache[servicePath] = previousService; else delete require.cache[servicePath];
	});

	const queue = (require("./internal-whatsapp-message-queue.service") as typeof import("./internal-whatsapp-message-queue.service")).default;
	const internals = queue as unknown as { processNext(): Promise<void>; recoverInterruptedItems(): Promise<void> };
	const seen: Array<Date | null> = [];
	const results: Array<InternalWhatsappQueueProcessResult | Error> = [];
	queue.setProcessHandler({
		process: async (item) => {
			seen.push(item.processingStartedAt);
			const next = results.shift()!;
			if (next instanceof Error) throw next;
			return next;
		}
	});
	const row: Row = {
		id: "q1", status: "PENDING", createdAt: new Date(Date.now() - 1_000), processingStartedAt: null, processedAt: null,
		lockedUntil: null, lockedBy: null, retryCount: 0, error: null, messageData: "{}", internalMessageId: 7
	};
	rows.set(row.id, row);
	const unlock = () => { row.lockedUntil = null; };

	results.push({ status: "PENDING" });
	await internals.processNext();
	const firstClaim = row.processingStartedAt;
	assert.ok(firstClaim instanceof Date);
	assert.equal(seen[0]?.getTime(), firstClaim!.getTime(), "the handler sees the claim time of this delivery");
	assert.equal(row.status, "PENDING");

	unlock();
	await new Promise((resolve) => setTimeout(resolve, 5));
	results.push(new Error("client unavailable"));
	await internals.processNext();
	assert.equal(row.processingStartedAt?.getTime(), firstClaim!.getTime(), "a thrown error keeps the first claim");
	assert.equal(row.retryCount, 1);

	unlock();
	row.status = "PROCESSING";
	await internals.recoverInterruptedItems();
	assert.equal(row.status, "PENDING");
	assert.equal(row.processingStartedAt?.getTime(), firstClaim!.getTime(), "restart recovery keeps the first claim");

	unlock();
	results.push({ status: "PENDING", messageData: "{\"timing\":{\"slowAlertedAt\":\"x\"}}" });
	await internals.processNext();
	assert.equal(row.messageData, "{\"timing\":{\"slowAlertedAt\":\"x\"}}", "payload returned with PENDING is persisted");

	unlock();
	results.push({ status: "FAILED", error: "[NOT_SENT] Connection Closed", messageData: "{\"outcome\":1}" });
	await internals.processNext();
	assert.equal(row.status, "FAILED");
	assert.equal(row.error, "[NOT_SENT] Connection Closed");
	assert.equal(row.messageData, "{\"outcome\":1}");
	assert.ok(row.processedAt);
	assert.equal(row.processingStartedAt?.getTime(), firstClaim!.getTime());
	assert.ok(seen.every((value) => value?.getTime() === firstClaim!.getTime()));

	assert.equal(await queue.reopenForManualRetry("q1", "{\"stale\":1}", "{\"retryGeneration\":1}"), false, "a stale payload snapshot never reopens");
	assert.equal(row.status, "FAILED");
	assert.equal(await queue.reopenForManualRetry("q1", "{\"outcome\":1}", "{\"retryGeneration\":1}"), true);
	assert.deepEqual(
		{ status: row.status, error: row.error, processedAt: row.processedAt, processingStartedAt: row.processingStartedAt, retryCount: row.retryCount },
		{ status: "PENDING", error: null, processedAt: null, processingStartedAt: null, retryCount: 0 }
	);
	assert.equal(await queue.reopenForManualRetry("q1", row.messageData, "{}"), false, "an item in flight is never reopened");
});
