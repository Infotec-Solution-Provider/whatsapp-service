import assert from "node:assert/strict";
import { MessageFlowCache } from "./message-flow-cache";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function main() {
	const cache = new MessageFlowCache<string>();
	let calls = 0;
	const first = deferred<string>();
	const load = () => { calls++; return calls === 1 ? first.promise : Promise.resolve("new"); };
	const one = cache.get("tenant-a", 12, load);
	const two = cache.get("tenant-a", 12, load);
	await Promise.resolve();
	assert.equal(calls, 1, "concurrent callers coalesce");
	assert.equal(await cache.get("tenant-b", 12, async () => "foreign"), "foreign");
	cache.invalidate("tenant-a", 12);
	first.resolve("old");
	assert.deepEqual(await Promise.all([one, two]), ["new", "new"], "late old fill is never returned or cached");
	assert.equal(calls, 2);
	assert.equal(await cache.get("tenant-b", 12, async () => "wrong"), "foreign", "invalidation is tenant scoped");
	assert.equal(await cache.get("tenant-a", 13, async () => "other-sector"), "other-sector");
	const failing = deferred<string>();
	const pending = cache.get("tenant-a", 15, () => failing.promise);
	await Promise.resolve();
	cache.invalidate("tenant-a", 15);
	const fresh = cache.get("tenant-a", 15, async () => "recovered");
	failing.reject(new Error("old load failure"));
	assert.deepEqual(await Promise.all([pending, fresh]), ["recovered", "recovered"]);
	await assert.rejects(cache.get("broken", 1, async () => { throw new Error("load failed"); }));
	assert.equal(await cache.get("broken", 1, async () => "retry"), "retry", "load failures do not poison cache");
	console.log("Message flow cache tests passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
