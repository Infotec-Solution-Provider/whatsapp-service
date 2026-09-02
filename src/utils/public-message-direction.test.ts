import assert from "node:assert/strict";
import { getPublicMessageDirection } from "./public-message-direction";
import { PublicBiRateLimiter } from "../middlewares/public-bi-rate-limit.middleware";

assert.deepEqual(getPublicMessageDirection({ from: "5511999999999", userId: null }), {
	direction: "INBOUND",
	senderType: "CONTACT"
});
assert.deepEqual(getPublicMessageDirection({ from: "me:5511888888888", userId: 10 }), {
	direction: "OUTBOUND",
	senderType: "ATTENDANT"
});
assert.deepEqual(getPublicMessageDirection({ from: "me:5511888888888", userId: null }), {
	direction: "OUTBOUND",
	senderType: "WHATSAPP_ACCOUNT"
});
assert.deepEqual(getPublicMessageDirection({ from: "bot:ai-agent:7", userId: null }), {
	direction: "OUTBOUND",
	senderType: "BOT"
});
assert.deepEqual(getPublicMessageDirection({ from: "system:auto-reply", userId: null }), {
	direction: "INTERNAL",
	senderType: "SYSTEM"
});
assert.deepEqual(getPublicMessageDirection({ from: "thirdparty:meta", userId: null }), {
	direction: "INTERNAL",
	senderType: "THIRD_PARTY"
});

let now = 1_000;
const limiter = new PublicBiRateLimiter(2, 60_000, () => now);
assert.equal(limiter.consume("token-a").allowed, true);
assert.equal(limiter.consume("token-a").allowed, true);
const rejected = limiter.consume("token-a");
assert.equal(rejected.allowed, false);
assert.equal(rejected.remaining, 0);
assert.equal(limiter.consume("token-b").allowed, true);
now += 60_000;
assert.equal(limiter.consume("token-a").allowed, true);

console.log("public-message-direction tests passed");
