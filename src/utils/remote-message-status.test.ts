import assert from "node:assert/strict";
import { REMOTE_STATUS_RETRY_DELAYS_MS, shouldApplyRemoteStatus } from "./remote-message-status";

assert.equal(shouldApplyRemoteStatus("PENDING", "SENT"), true);
assert.equal(shouldApplyRemoteStatus("SENT", "RECEIVED"), true);
assert.equal(shouldApplyRemoteStatus("SENT", "READ"), true);
assert.equal(shouldApplyRemoteStatus("RECEIVED", "READ"), true);

assert.equal(shouldApplyRemoteStatus("READ", "RECEIVED"), false, "a late delivery receipt must not undo READ");
assert.equal(shouldApplyRemoteStatus("RECEIVED", "SENT"), false);
assert.equal(shouldApplyRemoteStatus("SENT", "SENT"), false, "repeated receipts are no-ops");

assert.equal(shouldApplyRemoteStatus("SENT", "ERROR"), true, "WhatsApp rejections (error acks) must surface");
assert.equal(shouldApplyRemoteStatus("PENDING", "ERROR"), true);
assert.equal(shouldApplyRemoteStatus("UNKNOWN", "ERROR"), true);
assert.equal(shouldApplyRemoteStatus("READ", "ERROR"), false, "an error ack after delivery is stale");
assert.equal(shouldApplyRemoteStatus("ERROR", "READ"), true, "a later delivery receipt is more reliable than the error");
assert.equal(shouldApplyRemoteStatus("ERROR", "SENT"), false);

assert.equal(shouldApplyRemoteStatus("REVOKED", "READ"), false, "receipts never resurrect a revoked message");
assert.equal(shouldApplyRemoteStatus("UNKNOWN", "SENT"), true);
assert.equal(shouldApplyRemoteStatus("RECEIVED", "DOWNLOADED"), true, "statuses outside the ladder keep the old behavior");

assert.ok(
	REMOTE_STATUS_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) >= 30_000,
	"retries must outlast the outbound job poll that links the provider id"
);

console.log("remote message status tests passed");
