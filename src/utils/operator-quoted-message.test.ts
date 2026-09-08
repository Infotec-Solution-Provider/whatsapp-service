import assert from "node:assert/strict";
import { resolveOperatorQuotedMessage } from "./operator-quoted-message";
import { OperatorSendRequestError } from "./operator-send-request";

const scope = { instance: "tenant-a", contactId: 2, clientId: 3, clientType: "REMOTE" };
const quoted = {
	instance: "tenant-a",
	contactId: 2,
	clientId: 3,
	wwebjsId: "true_5511999999999@c.us_STANZA",
	wwebjsIdStanza: "STANZA",
	wabaId: null,
	gupshupId: null
};

assert.equal(resolveOperatorQuotedMessage(scope, quoted), "STANZA");
assert.equal(resolveOperatorQuotedMessage({ ...scope, clientType: "WWEBJS" }, quoted), quoted.wwebjsId);
assert.throws(() => resolveOperatorQuotedMessage(scope, { ...quoted, clientId: 4 }), OperatorSendRequestError);
assert.throws(() => resolveOperatorQuotedMessage(scope, { ...quoted, clientId: null }), OperatorSendRequestError);
assert.throws(() => resolveOperatorQuotedMessage(scope, { ...quoted, instance: "tenant-b" }), OperatorSendRequestError);
assert.throws(() => resolveOperatorQuotedMessage(scope, { ...quoted, contactId: 9 }), OperatorSendRequestError);
assert.throws(() => resolveOperatorQuotedMessage(scope, null), OperatorSendRequestError);
assert.throws(
	() => resolveOperatorQuotedMessage(scope, { ...quoted, wwebjsId: null, wwebjsIdStanza: null }),
	OperatorSendRequestError
);
assert.throws(
	() => resolveOperatorQuotedMessage({ ...scope, clientType: "WWEBJS" }, { ...quoted, wwebjsId: null }),
	OperatorSendRequestError,
	"a stanza-only ID cannot replace the serialized WWEBJS quotation ID"
);
assert.equal(
	resolveOperatorQuotedMessage(
		{ ...scope, clientType: "WABA" },
		{ ...quoted, wwebjsId: null, wwebjsIdStanza: null, wabaId: "wamid-1" }
	),
	"wamid-1"
);

console.log("Operator quoted message tests passed");
