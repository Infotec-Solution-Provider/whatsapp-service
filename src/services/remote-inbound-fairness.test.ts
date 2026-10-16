import assert from "node:assert/strict";

const mock = (path: string, exports: unknown) => {
	const id = require.resolve(path);
	require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
};
const now = Date.now();
const rows: any[] = [];
const delegate = {
	findMany: async ({ where, orderBy, take }: any) => {
		const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
		return rows.filter((row) => row.status === where.status && row.nextAttemptAt <= where.nextAttemptAt.lte)
			.sort((a, b) => {
				for (const order of orders) {
					const [key, direction] = Object.entries(order)[0]!;
					if (a[key] < b[key]) return direction === "asc" ? -1 : 1;
					if (a[key] > b[key]) return direction === "asc" ? 1 : -1;
				}
				return 0;
			}).slice(0, take).map(({ id }) => ({ id }));
	},
	updateMany: async ({ where, data }: any) => {
		const matches = rows.filter((row) =>
			(!where.id || row.id === where.id) && (!where.status || row.status === where.status) &&
			(!where.lockedBy || row.lockedBy === where.lockedBy) &&
			(!where.nextAttemptAt || row.nextAttemptAt <= where.nextAttemptAt.lte) &&
			(!where.lockedUntil || (row.lockedUntil && row.lockedUntil < where.lockedUntil.lt)));
		matches.forEach((row) => Object.assign(row, data));
		return { count: matches.length };
	},
	findUnique: async ({ where }: any) => {
		const row = rows.find((candidate) => candidate.id === where.id);
		return row ? { ...row } : null;
	}
};
mock("./prisma.service", { __esModule: true, default: { remoteInboundEventInbox: delegate } });
mock("@in.pulse-crm/utils", { Logger: { error() {} } });
const { RemoteInboundEventInboxService, calculateRemoteInboundRetryDelayMs } =
	require("./remote-inbound-event-inbox.service") as typeof import("./remote-inbound-event-inbox.service");

function item(id: string, createdAt: number, nextAttemptAt: number, retryCount: number, eventType: string): any {
	return { id, status: "PENDING", clientId: 11, createdAt: new Date(createdAt), nextAttemptAt: new Date(nextAttemptAt),
		retryCount, maxRetries: 0, eventType, lockedUntil: null, lockedBy: null,
		payload: { type: eventType.split(":")[0], clientId: 11 }, error: null };
}

async function main(): Promise<void> {
	const priorConcurrency = process.env["REMOTE_INBOUND_EVENT_CONCURRENCY"];
	process.env["REMOTE_INBOUND_EVENT_CONCURRENCY"] = "4";
	try {
		const oldCreatedAt = now - 7 * 86_400_000;
		for (let i = 0; i < 1200; i++) rows.push(item(`old-${i}`, oldCreatedAt + i,
			now - (i < 4 ? 3000 : 1000), 2303, "message-status-received:RECEIVED"));
		rows.push(item("fresh-receipt", now - 2000, now - 2000, 0, "message-status-received:READ"));
		rows.push(item("fresh-inbound", now - 2000, now - 2000, 0, "message-received"));
		const service = new RemoteInboundEventInboxService();
		const completed: string[] = [];
		let active = 0;
		let peak = 0;
		let recovered = false;
		service.setProcessor({ process: async (row) => {
			active++;
			peak = Math.max(peak, active);
			try {
				await Promise.resolve();
				if (row.id.startsWith("old-") && !recovered) throw new Error("REMOTE_RECEIPT_MESSAGE_NOT_FOUND");
				completed.push(row.id);
				return { messageId: 42 };
			} finally { active--; }
		} });
		await service.processOnce(); // Four already-due historical failures.
		await service.processOnce(); // Both new events must pass the historical backlog.
		assert.ok(completed.includes("fresh-receipt"), "New delivery/read receipts cannot starve behind old retries");
		assert.ok(completed.includes("fresh-inbound"), "New incoming messages cannot starve behind old receipts");
		assert.ok(peak <= 4, "Fairness must not increase database concurrency");
		for (let i = 0; i < 300; i++) await service.processOnce();
		const oldRows = rows.filter((row) => row.id.startsWith("old-"));
		assert.equal(oldRows.length, 1200, "No historical event is deleted");
		assert.ok(oldRows.every((row) => row.status === "PENDING" && row.retryCount === 2304 &&
			row.nextAttemptAt.getTime() >= now + 3_600_000 && row.lockedBy === null),
			"Unmatched historical receipts are retained and deferred, never falsely completed");
		const recovery = oldRows[0]!;
		recovery.nextAttemptAt = new Date(now - 1000); // Simulate its next scheduled attempt.
		recovered = true;
		await service.processOnce();
		assert.equal(recovery.status, "COMPLETED", "Late linking can still recover a historical receipt");
		assert.equal(recovery.messageId, 42);
		assert.equal(recovery.error, null);
		assert.equal(calculateRemoteInboundRetryDelayMs(1, "message-status-received:READ", "REMOTE_RECEIPT_MESSAGE_NOT_FOUND"), 2000);
		assert.equal(calculateRemoteInboundRetryDelayMs(7, "message-status-received:READ", "REMOTE_RECEIPT_MESSAGE_NOT_FOUND"), 128000);
		assert.equal(calculateRemoteInboundRetryDelayMs(8, "message-status-received:READ", "REMOTE_RECEIPT_MESSAGE_NOT_FOUND"), 3600000);
		assert.equal(calculateRemoteInboundRetryDelayMs(100, "message-received", "REMOTE_RECEIPT_MESSAGE_NOT_FOUND"), 256000);
		assert.equal(calculateRemoteInboundRetryDelayMs(100, "message-status-received:READ", "P2024"), 256000);
		assert.equal(calculateRemoteInboundRetryDelayMs(100, "message-status-received:READ", "REMOTE_RECEIPT_AMBIGUOUS_MESSAGE"), 256000);
		console.log("PASS: 1200 historical retries, fresh receipt/inbound progress in two batches, bounded concurrency, durable late recovery and scoped backoff");
	} finally {
		if (priorConcurrency === undefined) delete process.env["REMOTE_INBOUND_EVENT_CONCURRENCY"];
		else process.env["REMOTE_INBOUND_EVENT_CONCURRENCY"] = priorConcurrency;
	}
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
