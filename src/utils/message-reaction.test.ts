import assert from "node:assert/strict";
import { canonicalReactionTarget, positiveReactionId, reactionActor, reactionEmoji, reactionTimestamp } from "./message-reaction";

for (const emoji of ["", "👍", "👍🏽", "❤️", "👨‍👩‍👧‍👦", "🇧🇷", "1️⃣", "#️⃣"]) assert.equal(reactionEmoji(emoji), emoji);
for (const invalid of [undefined, null, 1, "ok", " ", "👍👍", "👍\n", "1", "#", "a".repeat(65)]) assert.throws(() => reactionEmoji(invalid));
assert.equal(canonicalReactionTarget("true_5511999999999@c.us_AABBCC"), "AABBCC");
assert.equal(canonicalReactionTarget("false_123@g.us_AABBCC_5511999999999@c.us"), "AABBCC");
assert.equal(canonicalReactionTarget("wamid.OPAQUE_123"), "wamid.OPAQUE_123");
assert.equal(reactionActor("5511:9@c.us", false), "5511@s.whatsapp.net");
assert.equal(reactionActor("123@lid", false), "123@lid");
assert.equal(reactionActor(undefined, false), "legacy:unknown");
assert.equal(reactionActor("123@lid", true), "self");
assert.equal(reactionTimestamp(1_700_000_000).getTime(), 1_700_000_000_000);
assert.equal(reactionTimestamp(1_700_000_000_001).getTime(), 1_700_000_000_001);
assert.equal(reactionTimestamp(null, new Date(1234)).getTime(), 1234);
assert.equal(positiveReactionId("12"), 12);
for (const invalid of [null, undefined, "", "1e2", "1.2", -1, 0, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => positiveReactionId(invalid));
console.log("Reaction validation, graphemes, provider IDs and actor normalization passed");
