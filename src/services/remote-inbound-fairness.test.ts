import assert from "node:assert/strict";
import { currentDatabaseTenant, withDatabaseTenant } from "../utils/database-tenant-context";

const mock = (path: string, exports: unknown) => {
	const id = require.resolve(path);
	require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
};
const now = Date.now();
const day = 86_400_000;
const rows: any[] = [];
const errorLogs: string[] = [];
const infoLogs: string[] = [];
let tenantSql = false;
let homologUnavailable = true;
let homologScanFailures = 0;
const tenantRows = () => {
	if (!tenantSql) return rows;
	const instance = currentDatabaseTenant();
	if (instance === "homolog" && homologUnavailable) {
		homologScanFailures++;
		throw Error("Unavailable homolog runtime");
	}
	assert.ok(instance === "suprimaxxi" || instance === "infotec" || instance === "homolog");
	return rows.filter(row => row.fixtureTenant === instance);
};
const delegate = {
	findMany: async ({ where, orderBy, take }: any) => {
		const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
		return tenantRows().filter((row) => row.status === where.status && row.nextAttemptAt <= where.nextAttemptAt.lte)
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
		const matches = tenantRows().filter((row) =>
			(!where.id || row.id === where.id) && (!where.status || row.status === where.status) &&
			(!where.lockedBy || row.lockedBy === where.lockedBy) &&
			(!where.nextAttemptAt || row.nextAttemptAt <= where.nextAttemptAt.lte) &&
			(!where.lockedUntil || (row.lockedUntil && row.lockedUntil < where.lockedUntil.lt)));
		matches.forEach((row) => Object.assign(row, data));
		return { count: matches.length };
	},
	findUnique: async ({ where }: any) => {
		const row = tenantRows().find((candidate) => candidate.id === where.id);
		return row ? { ...row } : null;
	}
};
mock("./prisma.service", { __esModule: true, default: { remoteInboundEventInbox: delegate } });
mock("../tenant-sql/registry", { tenantSqlEnabled: () => tenantSql });
mock("../tenant-sql/router", { tenantSqlInstanceNames: () => ["homolog", "suprimaxxi", "infotec"] });
mock("@in.pulse-crm/utils", {
	Logger: { error: (message: string) => errorLogs.push(message), info: (message: string) => infoLogs.push(message) },
	sanitizeErrorMessage: (error: unknown) => error instanceof Error ? error.message : "Unknown error"
});
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
			row.nextAttemptAt.getTime() >= now + day && row.nextAttemptAt.getTime() < Date.now() + day * 1.25 &&
			row.lockedBy === null), "Unmatched historical receipts are retained with daily, jittered retries");
		assert.equal(errorLogs.length, 0, "Known historical misses must not flood the error log");
		assert.equal(infoLogs.length, 0, "An already deferred receipt is not logged again");

		const recentMiss = item("old-recent", now - 240_000, now - 1000, 7, "message-status-received:READ");
		rows.push(recentMiss);
		await service.processOnce();
		assert.ok(recentMiss.nextAttemptAt.getTime() >= now + 3_600_000);
		assert.equal(infoLogs.length, 1, "The first defer is logged once");
		const terminal = item("old-terminal", now - day * 2, now - 1000, 9, "message-status-received:READ");
		terminal.maxRetries = 10;
		rows.push(terminal);
		await service.processOnce();
		assert.equal(terminal.status, "FAILED");
		assert.equal(errorLogs.length, 1, "A terminal failure remains an error");

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
		assert.equal(calculateRemoteInboundRetryDelayMs(100, "message-received", "REMOTE_RECEIPT_MESSAGE_NOT_FOUND", day), 256000);
		assert.equal(calculateRemoteInboundRetryDelayMs(100, "message-status-received:READ", "P2024", day), 256000);
		assert.equal(calculateRemoteInboundRetryDelayMs(100, "message-status-received:READ", "REMOTE_RECEIPT_AMBIGUOUS_MESSAGE", day), 256000);
		console.log("PASS: 1200 historical retries, fresh receipt/inbound progress in two batches, bounded concurrency, durable late recovery and scoped backoff");

		tenantSql = true;
		const suprimaxxi = { ...item("shared-inbox-id", now - 1000, now - 1000, 0, "message-received"),
			fixtureTenant: "suprimaxxi", status: "PROCESSING", lockedUntil: new Date(now - 1000) };
		const infotec = { ...item("shared-inbox-id", now - 1000, now - 1000, 0, "message-received"),
			fixtureTenant: "infotec" };
		rows.push(suprimaxxi, infotec);
		const scopedRuns: Array<string | null> = [];
		service.setProcessor({ process: async () => {
			const instance = currentDatabaseTenant();
			scopedRuns.push(instance);
			return { messageId: instance === "suprimaxxi" ? 7 : 8 };
		} });
		await withDatabaseTenant("infotec", () => service.processOnce());
		assert.equal(suprimaxxi.status, "PROCESSING");
		assert.equal(infotec.status, "COMPLETED");
		await service.processOnce();
		assert.deepEqual(scopedRuns, ["infotec", "suprimaxxi"]);
		assert.equal(suprimaxxi.status, "COMPLETED");
		assert.equal(suprimaxxi.messageId, 7);
		assert.equal(infotec.messageId, 8);
		assert.match(errorLogs.at(-1) ?? "", /Worker loop error for homolog: Unavailable homolog runtime/);
		assert.equal(currentDatabaseTenant(), null);
		console.log("PASS: explicit tenant retained, missing tenant isolated, and overlapping inbox IDs recovered and completed in their own scope");

		const realNow = Date.now;
		let retryClock = realNow();
		Date.now = () => retryClock;
		try {
			const healthy = { ...item("healthy-during-backoff", now - 1000, now - 1000, 0, "message-received"),
				fixtureTenant: "suprimaxxi" };
			rows.push(healthy);
			await service.processOnce();
			assert.equal(homologScanFailures, 1);
			assert.equal(healthy.status, "COMPLETED");
			await assert.rejects(withDatabaseTenant("homolog", () => service.processOnce()), /Unavailable homolog runtime/);
			assert.equal(homologScanFailures, 2, "Explicit scoped calls still attempt their own batch");
			retryClock += 5_001;
			const recoveredPeer = { ...item("homolog-recovered", now - 1000, now - 1000, 0, "message-received"),
				fixtureTenant: "homolog" };
			rows.push(recoveredPeer);
			homologUnavailable = false;
			await service.processOnce();
			assert.equal(recoveredPeer.status, "COMPLETED");
			assert.equal(currentDatabaseTenant(), null);
		} finally {
			Date.now = realNow;
		}
		console.log("PASS: failed tenant backs off while healthy work continues and resumes after the delay");
	} finally {
		if (priorConcurrency === undefined) delete process.env["REMOTE_INBOUND_EVENT_CONCURRENCY"];
		else process.env["REMOTE_INBOUND_EVENT_CONCURRENCY"] = priorConcurrency;
	}
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
