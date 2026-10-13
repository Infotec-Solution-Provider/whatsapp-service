import assert from "node:assert/strict";
import { AsyncConcurrencyLimiter, AsyncKeyedSequencer } from "./async-concurrency-limiter";
import { shouldApplyRemoteStatus } from "./remote-message-status";

async function main(): Promise<void> {
	const limiter = new AsyncConcurrencyLimiter(4);
	let active = 0, peak = 0, completed = 0;
	const outcomes = await Promise.allSettled(Array.from({ length: 292 }, (_, i) => limiter.run(async () => {
		active++; peak = Math.max(peak, active);
		await new Promise<void>((resolve) => setImmediate(resolve));
		active--; completed++;
		if (i === 5) throw new Error("database failure");
		return i;
	})));
	assert.equal(peak, 4);
	assert.equal(completed, 292);
	assert.equal(outcomes.filter((r) => r.status === "rejected").length, 1);
	assert.equal(await limiter.run(async () => 42), 42);
	const sequencer = new AsyncKeyedSequencer();
	let current: "SENT" | "READ" | "RECEIVED" = "SENT";
	await Promise.all(["READ", "RECEIVED"].map((next) => sequencer.run("client:message", async () => {
		const snapshot = current;
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (shouldApplyRemoteStatus(snapshot, next)) current = next as typeof current;
	})));
	assert.equal(current, "READ");
	await assert.rejects(sequencer.run("client:message", async () => { throw new Error("retry"); }));
	assert.equal(await sequencer.run("client:message", async () => "recovered"), "recovered");
	console.log("292 receipts retained, concurrency <=4, failures released, status progression serialized");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
