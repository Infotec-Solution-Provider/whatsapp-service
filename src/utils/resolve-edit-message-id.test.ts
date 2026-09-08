import assert from "node:assert/strict";
import { resolveEditMessageId } from "./resolve-edit-message-id";

const bothIds = {
	wwebjsId: "true_5551999999999@c.us_A1B2C3",
	wwebjsIdStanza: "A1B2C3"
};

assert.equal(resolveEditMessageId("WWEBJS", bothIds), bothIds.wwebjsId);
assert.equal(resolveEditMessageId("STANZA_FIRST", bothIds), bothIds.wwebjsIdStanza);
assert.equal(resolveEditMessageId("STANZA_FIRST", { wwebjsId: bothIds.wwebjsId }), bothIds.wwebjsId);
assert.equal(resolveEditMessageId("WWEBJS", { wwebjsIdStanza: bothIds.wwebjsIdStanza }), null);

console.log("WhatsApp edit message ID tests passed");
