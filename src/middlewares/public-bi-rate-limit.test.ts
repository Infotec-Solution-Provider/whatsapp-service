import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { parseBiTenantRateProfiles, resolveBiRateLimits } from "../utils/public-bi-rate-policy";

const profile = {
	instance: "tenant-a", maxRequests: 50, maxConcurrent: 4,
	night: { start: "22:00", end: "06:00", timeZone: "America/Sao_Paulo", maxRequests: 150, maxConcurrent: 2 }
};
assert.equal(parseBiTenantRateProfiles(JSON.stringify([profile])).length, 1);
const defaults = { maxRequests: 50, maxConcurrent: 4 };
assert.equal(resolveBiRateLimits(profile, defaults, new Date("2026-10-20T00:59:59Z")).maxRequests, 50);
assert.equal(resolveBiRateLimits(profile, defaults, new Date("2026-10-20T01:00:00Z")).maxRequests, 150);
assert.equal(resolveBiRateLimits(profile, defaults, new Date("2026-10-20T08:59:59Z")).maxRequests, 150);
assert.equal(resolveBiRateLimits(profile, defaults, new Date("2026-10-20T09:00:00Z")).maxRequests, 50);
assert.equal(resolveBiRateLimits(undefined, defaults, new Date()).maxConcurrent, 4);
assert.throws(() => parseBiTenantRateProfiles(JSON.stringify([{ ...profile, instance: "../../tenant" }])), /Invalid/);
assert.throws(() => parseBiTenantRateProfiles(JSON.stringify([profile, profile])), /Invalid/);
assert.throws(() => parseBiTenantRateProfiles(JSON.stringify([{ ...profile, night: { ...profile.night, timeZone: "not-a-zone" } }])), /timezone/);
assert.throws(() => parseBiTenantRateProfiles(JSON.stringify([{ ...profile, maxConcurrent: 1000 }])), /Invalid/);

// Load the middleware with an isolated, small tenant quota; no real environment files are used.
const previous = process.env["PUBLIC_BI_RATE_PROFILES_JSON"];
process.env["PUBLIC_BI_RATE_PROFILES_JSON"] = JSON.stringify([{ instance: "tenant-a", maxRequests: 2, maxConcurrent: 1 }]);
const { default: middleware, PublicBiRateLimiter } = require("./public-bi-rate-limit.middleware") as typeof import("./public-bi-rate-limit.middleware");
if (previous === undefined) delete process.env["PUBLIC_BI_RATE_PROFILES_JSON"]; else process.env["PUBLIC_BI_RATE_PROFILES_JSON"] = previous;

class FakeResponse extends EventEmitter {
	statusCode = 200;
	headers: Record<string, string> = {};
	setHeader(name: string, value: string) { this.headers[name] = value; return this; }
	status(code: number) { this.statusCode = code; return this; }
	json(_value: unknown) { return this; }
}
function call(instance: string, token: string) {
	const req = { headers: { authorization: token }, session: { instance } } as unknown as Request;
	const res = new FakeResponse();
	let next = 0;
	middleware(req, res as unknown as Response, () => { next++; });
	return { res, next };
}
const first = call("tenant-a", "token-a");
assert.equal(first.next, 1);
assert.equal(first.res.headers["RateLimit-Limit"], "2");
const concurrent = call("tenant-a", "token-b");
assert.equal(concurrent.res.statusCode, 429); // a different token still shares tenant concurrency
first.res.emit("close");
first.res.emit("finish"); // close+finish must release only once
assert.equal(call("tenant-a", "token-c").res.statusCode, 429); // concurrency refusals also consume request quota
assert.equal(call("unconfigured-tenant", "token-c").next, 1); // other tenants retain the default policy

let now = 1000;
const limiter = new PublicBiRateLimiter(2, 60000, () => now);
assert.equal(limiter.consume("a", 5).allowed, true);
assert.equal(limiter.consume("a", 5).allowed, true);
assert.equal(limiter.consume("a", 2).allowed, false); // lowering daytime quota does not reset the bucket
assert.equal(limiter.consume("a", 5).remaining, 2);
now += 60000;
assert.equal(limiter.consume("a", 2).remaining, 1);
console.log("public-bi-rate-limit: night boundaries, validation, shared tenant quota and concurrency passed");
