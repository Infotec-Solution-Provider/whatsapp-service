import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import protectedRead, { readRequestKey } from "./protected-read";
import { ReadRequestGate, ReadRequestLimitError } from "../utils/read-request-gate";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const options = { maxRequests: 30, windowMs: 10_000, maxConcurrent: 1, maxWaiters: 2, maxUsers: 2 };
const request = () => ({ session: { instance: "a", userId: 1, sectorId: 2, role: "USER", name: "User" },
	params: {}, query: { page: "1", name: "test" }, body: undefined } as unknown as Request);
class Reply extends EventEmitter {
	destroyed = false;
	statusCode = 200;
	body: any;
	headers: Record<string, string> = {};
	status(code: number) { this.statusCode = code; return this; }
	json(body: unknown) { this.body = body; return this; }
	setHeader(key: string, value: string) { this.headers[key] = value; }
	close() { this.destroyed = true; this.emit("close"); }
}
async function main() {
	let now = 0;
	const gate = new ReadRequestGate(options, () => now);
	const work = deferred<number>();
	let calls = 0;
	const execute = () => { calls++; return work.promise; };
	const first = new AbortController();
	const a = gate.run("a:1", "same", execute, first.signal);
	first.abort();
	assert.equal(await a, undefined);
	now = 20_000; // Neither disconnect nor expiry may release running work.
	await assert.rejects(gate.run("a:1", "different", execute), ReadRequestLimitError);
	const b = gate.run("a:1", "same", execute);
	const c = gate.run("a:1", "same", execute);
	await assert.rejects(gate.run("a:1", "same", execute), ReadRequestLimitError);
	assert.equal(calls, 1);
	work.resolve(42);
	assert.deepEqual(await Promise.all([b, c]), [42, 42]);
	assert.equal(await gate.run("a:1", "same", async () => 43), 43, "completed data must not be cached");

	const broken = deferred<number>();
	const f1 = gate.run("a:1", "failure", () => broken.promise);
	const f2 = gate.run("a:1", "failure", () => broken.promise);
	const outcomes = Promise.allSettled([f1, f2]);
	broken.reject(new Error("db failed"));
	assert.deepEqual((await outcomes).map(value => value.status), ["rejected", "rejected"]);
	assert.equal(await gate.run("a:1", "failure", async () => 44), 44);

	const quota = new ReadRequestGate({ ...options, maxRequests: 2 }, () => now);
	await quota.run("a:1", "x", async () => 1);
	await quota.run("a:1", "x", async () => 1);
	await assert.rejects(quota.run("a:1", "x", async () => 1), (error: unknown) =>
		error instanceof ReadRequestLimitError && error.retryAfterSeconds === 10);
	assert.equal(await quota.run("b:1", "x", async () => 2), 2, "tenants must not share quotas");
	await assert.rejects(quota.run("c:1", "x", async () => 3), ReadRequestLimitError);
	now += 10_000;
	assert.equal(await quota.run("c:1", "x", async () => 3), 3, "expired idle buckets must be reclaimed");

	const req = request();
	const key = readRequestKey("contacts", req);
	assert.equal(readRequestKey("contacts", { ...req, query: { name: "test", page: "1" } }), key);
	for (const variant of [
		{ ...req, query: { page: "2" } }, { ...req, body: { filters: { unread: true } } },
		...([{ userId: 2 }, { instance: "b" }, { role: "ADMIN" }, { sectorId: 3 }]).map(change =>
			({ ...req, session: { ...req.session, ...change } }))
	]) assert.notEqual(readRequestKey("contacts", variant), key);
	assert.notEqual(readRequestKey("chats", req), key);
	assert.throws(() => readRequestKey("contacts", { ...req, body: { text: "a".repeat(33000) } }));

	// Repeated F5 must not accumulate abandoned waiters across rate windows.
	const reloadGate = new ReadRequestGate(options, () => now);
	const longRead = deferred<number>();
	let reloadCalls = 0;
	for (let index = 0; index < 100; index++) {
		now += 1000;
		const abort = new AbortController();
		const pending = reloadGate.run("reload", "same", () => { reloadCalls++; return longRead.promise; }, abort.signal);
		abort.abort();
		await pending;
	}
	assert.equal(reloadCalls, 1);
	const finalReload = reloadGate.run("reload", "same", () => longRead.promise);
	longRead.resolve(100);
	assert.equal(await finalReload, 100);

	// Exercise HTTP adapter: close the original response, then F5 rejoins its work.
	const httpWork = deferred<object>();
	let httpCalls = 0;
	const handler = protectedRead("test", async () => { httpCalls++; return httpWork.promise; }, new ReadRequestGate(options));
	const old = new Reply();
	const oldRequest = handler(request(), old as unknown as Response);
	await Promise.resolve();
	old.close();
	await oldRequest;
	const fresh = new Reply();
	const freshRequest = handler(request(), fresh as unknown as Response);
	const excess = new Reply();
	const different = request(); different.query = { page: "2" };
	await handler(different, excess as unknown as Response);
	assert.equal(excess.statusCode, 429);
	assert.equal(excess.headers["Retry-After"], "2");
	assert.equal(excess.body.code, "READ_REQUEST_LIMIT");
	httpWork.resolve({ data: [42] });
	await freshRequest;
	assert.equal(httpCalls, 1);
	assert.equal(old.body, undefined);
	assert.deepEqual(fresh.body, { data: [42] });
	assert.equal(fresh.listenerCount("close"), 0);
	assert.equal(old.listenerCount("close"), 0);
	console.log("protected-read: sharing, disconnect, quotas, isolation, failures and HTTP contracts passed");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
