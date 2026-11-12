import assert from "node:assert/strict";
import { assertWabaReactionTarget, parseWabaReaction, WABA_REACTION_MAX_AGE_MS } from "./waba-reaction";

const now = 1_794_487_020_000;
const target = { instance: "tenant", wabaId: "wamid.target", from: "5511999999999", to: "me:5511888888888", type: "text", status: "READ", timestamp: String(now) };
assert.equal(assertWabaReactionTarget(target, target.from, "5511888888888", now), target.wabaId);
assert.equal(assertWabaReactionTarget({ ...target, from: "me:5511888888888", to: target.from }, target.from, "5511888888888", now), target.wabaId);
assert.equal(assertWabaReactionTarget({ ...target, timestamp: String((now - WABA_REACTION_MAX_AGE_MS) / 1000) }, target.from, "5511888888888", now), target.wabaId);
assert.equal(assertWabaReactionTarget({ ...target, instance: "odim", to: "me:odim-legacy-copy", type: "chat" }, target.from, "5511888888888", now), target.wabaId);
assert.equal(assertWabaReactionTarget({ ...target, instance: "odim", from: "me:odim-legacy-copy", to: target.from, type: "chat" }, target.from, "5511888888888", now), target.wabaId);
for (const changes of [{ wabaId: "remote-id" }, { status: "UNKNOWN" }, { status: "PENDING" }, { status: "ERROR" },
	{ status: "REVOKED" }, { type: "reaction" }, { type: "thirdparty:meta" }, { type: "system" }, { from: "me:5511888888888" },
	{ timestamp: String(now - WABA_REACTION_MAX_AGE_MS - 1) }, { timestamp: String(now + 300_001) },
	{ to: "me:5511000000000" }, { instance: "tenant", to: "me:odim-legacy-copy", type: "chat" }]) {
	assert.throws(() => assertWabaReactionTarget({ ...target, ...changes }, target.from, "5511888888888", now));
}
const message = { type: "reaction", id: "wamid.event", from: target.from, timestamp: String(Math.floor(now / 1000)), reaction: { message_id: target.wabaId, emoji: "👍" } };
const event = parseWabaReaction(13, message, now);
assert.deepEqual(event, { type: "message-reaction", clientId: 13, targetMessageId: target.wabaId, reaction: "👍", removed: false,
	isGroup: false, groupId: null, actorId: `${target.from}@s.whatsapp.net`, fromMe: false, timestamp: Math.floor(now / 1000) * 1000, reactionId: message.id });
for (const emoji of [undefined, ""]) assert.equal(parseWabaReaction(13, { ...message, reaction: { message_id: target.wabaId, ...(emoji === undefined ? {} : { emoji }) } }, now).removed, true);
for (const change of [{ id: "local" }, { from: "group@g.us" }, { timestamp: "bad" }, { reaction: { message_id: "remote", emoji: "👍" } }, { reaction: { message_id: target.wabaId, emoji: "hello" } }]) {
	assert.throws(() => parseWabaReaction(13, { ...message, ...change }));
}
assert.throws(() => parseWabaReaction(13, { ...message, timestamp: String(Math.floor((now + 301_000) / 1000)) }, now));
console.log("waba-reaction: official payload, removal, time boundaries, confirmed targets and channel/recipient restrictions passed");
