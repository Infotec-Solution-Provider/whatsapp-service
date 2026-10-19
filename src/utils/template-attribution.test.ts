import assert from "node:assert/strict";
import { getTemplateAttribution } from "./template-attribution";
import { getPublicMessageDirection } from "./public-message-direction";
import { getReportMessageType } from "./report-rules";

const providerMessage = { from: "me:5500000000000", to: "5500000000001", userId: null, agentId: null };
const sentByHuman = { ...providerMessage, ...getTemplateAttribution(81) };
assert.equal(sentByHuman.userId, 81, "the initiator remains the author even if the conversation belongs to someone else");
assert.equal(sentByHuman.agentId, null);
assert.equal(getReportMessageType(sentByHuman), "SENT", "authorship correction preserves message totals");
assert.equal(getPublicMessageDirection(sentByHuman).senderType, "ATTENDANT");
assert.deepEqual(getTemplateAttribution(81, 7), { userId: null, agentId: 7 }, "an agent must not inherit its supervisor's authorship");
for (const invalid of [-1, 0, NaN, Infinity, 1.5]) {
	assert.equal(getTemplateAttribution(invalid).userId, null, "non-human sessions do not acquire an author");
}
assert.deepEqual(getTemplateAttribution(81, null), { userId: 81, agentId: null });
console.log("template-attribution: human initiator, automation and report compatibility passed");
