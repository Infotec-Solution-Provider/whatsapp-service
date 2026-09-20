import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { databaseOperationExtension } from "./database-operation-extension";
import { DatabaseOperationMetrics } from "./database-operation-metrics";

async function main() {
	let now = 0;
	const reports: Record<string, unknown>[] = [];
	const metrics = new DatabaseOperationMetrics({ clock: () => now, slowMs: 1_000, report: (entry) => { reports.push(entry); } });
	let release!: (value: unknown[]) => void;
	const result = [{ secret: "private message and phone" }];
	const pending = metrics.measure("WppMessage", "findMany", () => new Promise<unknown[]>((resolve) => { release = resolve; }));
	now = 2_000;
	const during = metrics.snapshot();
	assert.equal(during.inFlight, 1);
	assert.deepEqual(during.active, [{ operation: "WppMessage.findMany", elapsedMs: 2_000 }]);
	release(result);
	assert.equal(await pending, result, "observation must preserve the original result");
	assert.equal(metrics.snapshot().inFlight, 0);
	assert.equal(during.inFlight, 1, "incident snapshots must not mutate after completion");
	assert.equal(metrics.snapshot().recent[0]?.resultRows, 1);
	assert.equal(metrics.snapshot().operations[0]?.maxResultRows, 1);
	assert.equal(reports.length, 1);

	const failure = Object.assign(new Error("mysql://private-password SQL with private message"), { code: "P2024" });
	await assert.rejects(metrics.measure(undefined, "$queryRawUnsafe", async () => { throw failure; }), (error: unknown) => error === failure);
	assert.equal(metrics.snapshot().inFlight, 0);
	assert.equal(metrics.snapshot().recent[1]?.code, "P2024");
	assert.equal(reports.length, 1, "reporting must be rate limited across all operations");
	now += 5_000;
	await assert.rejects(metrics.measure("WppMessage", "create", async () => { throw failure; }));
	assert.equal(reports[1]?.["suppressed"], 1);
	assert.doesNotMatch(JSON.stringify({ snapshot: metrics.snapshot(), reports }), /private|password|mysql:\/\//);

	const noisy = new DatabaseOperationMetrics({ clock: () => now, slowMs: 1, report: () => { throw new Error("logger failed"); } });
	assert.equal(await noisy.measure("WppMessage", "count", async () => { now += 2; return 5; }), 5);
	await assert.rejects(noisy.measure("WppMessage", "count", async () => { now += 5_000; throw failure; }), (error: unknown) => error === failure);
	const disabled = new DatabaseOperationMetrics({ enabled: false, report: () => { throw new Error("must not report"); } });
	assert.equal(await disabled.measure("WppMessage", "findMany", async () => result), result);
	assert.deepEqual(disabled.snapshot().operations, []);

	// Saturation must not produce unbounded tracking during an outage.
	const bounded = new DatabaseOperationMetrics({ clock: () => now, slowMs: 1 });
	const releases: (() => void)[] = [];
	const outstanding = Array.from({ length: 400 }, (_, index) => bounded.measure(`Model${index}`, "findMany", () => new Promise<void>((done) => { releases.push(done); })));
	assert.equal(bounded.snapshot().inFlight, 400);
	assert.equal(bounded.snapshot().untrackedInFlight, 144);
	assert.equal(bounded.snapshot().active.length, 20);
	now += 5_000;
	releases.forEach((done) => done());
	await Promise.all(outstanding);
	const after = bounded.snapshot();
	assert.equal(after.inFlight, 0);
	assert.equal(after.untrackedInFlight, 0);
	assert.equal(after.active.length, 0);
	assert.equal(after.recent.length, 20);
	assert.equal(after.operations.length, 20);
	assert.ok(after.operations.some((entry) => entry.operation === "other"));

	// Exercise the actual Prisma extension dispatch without touching a database.
	// The terminal extension is the only fake; it never invokes query(args).
	const clientMetrics = new DatabaseOperationMetrics({ clock: () => now });
	const calls: Array<{ model: string | undefined; operation: string; args: unknown }> = [];
	const base = new PrismaClient({ datasources: { db: { url: "mysql://unused:unused@127.0.0.1:1/unused" } } });
	const client = base.$extends(databaseOperationExtension(clientMetrics)).$extends({
		query: {
			$allOperations({ model, operation, args }) {
				calls.push({ model, operation, args });
				now += 1_500;
				if (operation === "count") throw failure;
				return Promise.resolve(result);
			},
		},
	});
	try {
		await client.wppMessage.findMany({ where: { body: "private message" }, take: 3 });
		await client.$queryRawUnsafe("SELECT ?", "private parameter");
		await assert.rejects(client.wppMessage.count(), /private-password/);
		assert.deepEqual(calls[0], { model: "WppMessage", operation: "findMany", args: { where: { body: "private message" }, take: 3 } });
		assert.equal(calls[1]?.operation, "$queryRawUnsafe");
		assert.equal(calls[1]?.model, undefined);
		assert.equal(clientMetrics.snapshot().recent.length, 3);
		assert.equal(clientMetrics.snapshot().inFlight, 0);
		assert.doesNotMatch(JSON.stringify(clientMetrics.snapshot()), /private|SELECT|unused/);
	} finally { await base.$disconnect(); }
	console.log("database operation metrics: elapsed/in-flight, identity, privacy, bounds, rate limiting and real Prisma extension dispatch passed (no database)");
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
