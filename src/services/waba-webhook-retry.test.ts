import assert from "node:assert/strict";
import { MessageReactionError } from "../utils/message-reaction";
import { decideWabaWebhookRetry as decide } from "./waba-webhook-retry";

const missingReceipt = new Error("missing");
missingReceipt.name = "MessageStatusTargetNotFoundError";
const reconciliation = "WABA_RECEIPT_RECONCILIATION_REQUIRED";
const unsupportedSocketEvent = Object.assign(new Error("HTTP 400"), {
	isAxiosError: true, response: { status: 400, data: { message: "Invalid event type." } }
});
const storageRefused = Object.assign(new Error("storage refused"), { code: "ECONNREFUSED" });

assert.deepEqual(decide(missingReceipt, 5, 30, 899), { retry: true, code: reconciliation });
assert.deepEqual(decide(missingReceipt, 5, 30, 900), { retry: false, code: reconciliation });
assert.deepEqual(decide(new Error("WABA_REACTION_RECEIPT_NOT_FOUND"), 30, 30, 1), { retry: false, code: reconciliation });
assert.equal(decide(unsupportedSocketEvent, 1, 30, 0).retry, false);
assert.equal(decide(new MessageReactionError("recipient mismatch", 409), 1, 30, 0).retry, false);
assert.equal(decide(new Error("WABA_MESSAGE_IDENTITY_MISMATCH"), 1, 30, 0).retry, false);
assert.equal(decide(storageRefused, 29, 30, 900).retry, true);
assert.equal(decide(storageRefused, 30, 30, 900).retry, false);
assert.equal(decide(new Error("unknown infrastructure error"), 1, 30, 0).retry, true);
console.log("waba-webhook-retry: permanent failures, delayed status and retry limits passed");
