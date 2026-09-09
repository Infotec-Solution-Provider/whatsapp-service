import assert from "node:assert/strict";
import { resolveWorkerConcurrency } from "../utils/worker-concurrency";

type FailureStage = "claim" | "read" | "record-failure";

const previousModules = new Map<string, NodeModule | undefined>();
function mockModule(id: string, exports: unknown): void {
	const path = require.resolve(id);
	previousModules.set(path, require.cache[path]);
	require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeModule;
}

const delegates: Record<string, unknown> = {};

// No real database, timer-driven worker or provider is used by these tests.
mockModule("./prisma.service", { default: delegates, __esModule: true });
mockModule("@in.pulse-crm/utils", { Logger: { error: () => undefined } });

const { RemoteInboundEventInboxService } = require("./remote-inbound-event-inbox.service") as typeof import("./remote-inbound-event-inbox.service");

async function testBatchDrainsOnDatabaseFailure(stage: FailureStage): Promise<void> {
	const timeout = Object.assign(new Error(`Injected P2024 during ${stage}`), { code: "P2024" });
	const rows = Array.from({ length: 12 }, (_, index) => ({
		id: `item-${index}`, idempotencyKey: `item-${index}`, status: "PENDING", retryCount: 0,
		maxRetries: 0, payload: {}, lockedBy: null as string | null,
	}));
	let candidateQueries = 0;
	let active = 0;
	let peak = 0;
	let settled = false;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const deliver = async (id: string) => {
		if (id === "item-0" && stage === "record-failure") throw new Error("Provider failure");
		active++;
		peak = Math.max(peak, active);
		try { await gate; } finally { active--; }
		return { messageId: 123 };
	};
	const delegate = {
		findMany: async (args: { take: number; select: unknown; orderBy: unknown }) => {
			candidateQueries++;
			assert.equal(args.take, 4);
			assert.deepEqual(args.select, { id: true });
			assert.deepEqual(args.orderBy, { createdAt: "asc" });
			return rows.filter((row) => row.status === "PENDING").slice(0, args.take).map(({ id }) => ({ id }));
		},
		updateMany: async ({ where, data }: { where: { id?: string }; data: { status: string; retryCount?: number } }) => {
			if (!where.id) return { count: 0 }; // Expired-lease sweep.
			if (where.id === "item-0" && (
				(stage === "claim" && data.status === "PROCESSING") ||
				(stage === "record-failure" && data.status === "PENDING" && data.retryCount === 1)
			)) throw timeout;
			const row = rows.find((candidate) => candidate.id === where.id)!;
			Object.assign(row, data);
			return { count: 1 };
		},
		findUnique: async ({ where }: { where: { id: string } }) => {
			if (where.id === "item-0" && stage === "read") throw timeout;
			return rows.find((row) => row.id === where.id);
		},
	};
	delegates["remoteInboundEventInbox"] = delegate;
	const service = new RemoteInboundEventInboxService();
	service.setProcessor({ process: (item) => deliver(item.id) });
	const result = service.processOnce().then(() => null, (error: unknown) => error).finally(() => { settled = true; });

	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(active, 3, `inbound/${stage}: sibling jobs must still be active`);
		assert.equal(settled, false, `inbound/${stage}: failed database operation must not release the batch`);
		await service.processOnce(); // Simulate the next polling tick during the outage.
		assert.equal(candidateQueries, 1, `inbound/${stage}: overlapping polling must not admit another batch`);
		assert.ok(peak <= 4);
	} finally {
		release();
	}
	const error = await result;
	assert.equal(active, 0);
	assert.equal(error, timeout);
	assert.ok(rows.slice(1, 4).every((row) => row.status === "COMPLETED"), "Healthy siblings must finish durably");
	assert.ok(rows.slice(4).every((row) => row.status === "PENDING"), "Excess work must remain in the database");
	console.log(`PASS inbound: ${stage} failure drains siblings and prevents overlapping batches`);
}

async function main(): Promise<void> {
	assert.equal(resolveWorkerConcurrency(undefined), 4);
	for (const value of ["", "bad", "NaN", "Infinity", "0", "-3"]) assert.equal(resolveWorkerConcurrency(value), 4);
	assert.equal(resolveWorkerConcurrency("1"), 1);
	assert.equal(resolveWorkerConcurrency("3.9"), 3);
	assert.equal(resolveWorkerConcurrency("100"), 8);
	console.log("PASS worker concurrency: safe default, validation and upper bound");
	const envKeys = ["REMOTE_INBOUND_EVENT_CONCURRENCY"];
	const previousEnv = envKeys.map((key) => process.env[key]);
	for (const key of envKeys) delete process.env[key];
	try {
		for (const stage of ["claim", "read", "record-failure"] as const) await testBatchDrainsOnDatabaseFailure(stage);
	} finally {
		envKeys.forEach((key, index) => {
			const previous = previousEnv[index];
			if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
		});
		for (const [path, previous] of previousModules) {
			if (previous) require.cache[path] = previous; else delete require.cache[path];
		}
	}
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
