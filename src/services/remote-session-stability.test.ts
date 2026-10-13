import assert from "node:assert/strict";
import { calculateSessionStability, StabilitySnapshot, FunctionalHealthSnapshot } from "./remote-session-stability";
import { emptyMessageHealth } from "./channel-message-health";

const now = Date.parse("2026-10-09T12:00:00Z");
const snapshot = (state = "CONNECTED", age = 0, stateAge = 0, failures = 0): StabilitySnapshot => ({
	state,
	lastObservedAt: new Date(now - age * 1000),
	stateChangedAt: new Date(now - stateAge * 1000),
	consecutivePollFailures: failures
});
const healthy = emptyMessageHealth(now);
const probe: FunctionalHealthSnapshot = {
	dispatchStatus: "PASSED",
	officialReceiveStatus: "PASSED",
	responseDispatchStatus: "PASSED",
	receiveStatus: "PASSED",
	expiresAt: new Date(now + 60_000).toISOString(),
	latencyMs: 1200,
	reason: "passed"
};
const calculate = (
	session = snapshot(),
	health = healthy,
	check: FunctionalHealthSnapshot | null = probe,
	disconnections = 0
) => calculateSessionStability(session, disconnections, now, check, health);

assert.equal(calculateSessionStability(null, 0, now, probe, healthy).level, "NO_DATA");
assert.equal(calculate(snapshot("LOGGED_OUT")).level, "LOGGED_OUT");
assert.equal(calculate().level, "STABLE");
assert.equal(
	calculate(snapshot(), healthy, probe, 100).level,
	"STABLE",
	"past disconnections cannot override current functional health"
);
assert.equal(calculate(snapshot("CONNECTED", 50)).level, "ATTENTION");
assert.equal(calculate(snapshot("CONNECTED", 91)).level, "UNSTABLE");
assert.equal(calculate(snapshot("CONNECTED", 0, 0, 3)).level, "UNSTABLE");
for (const state of ["STARTING", "RECONNECTING", "QR_PENDING", "unknown"])
	assert.equal(calculate(snapshot(state)).level, "ATTENTION");
assert.equal(calculate(snapshot("DISCONNECTED", 0, 301)).level, "UNSTABLE");
assert.equal(
	calculate(snapshot(), healthy, null).level,
	"ATTENTION",
	"connection alone does not prove functional health"
);
assert.equal(calculate(snapshot(), healthy, { ...probe, expiresAt: new Date(now).toISOString() }).level, "ATTENTION");
assert.equal(calculate(snapshot(), healthy, { ...probe, expiresAt: "invalid" }).level, "ATTENTION");
for (const field of ["dispatchStatus", "officialReceiveStatus", "receiveStatus"] as const) {
	assert.equal(calculate(snapshot(), healthy, { ...probe, [field]: "FAILED" }).level, "UNSTABLE");
}
assert.equal(
	calculate(snapshot(), healthy, { ...probe, responseDispatchStatus: "FAILED", receiveStatus: "FAILED" }).level,
	"ATTENTION",
	"responder failure cannot establish a fault in every monitored session"
);
assert.equal(calculate(snapshot(), healthy, { ...probe, dispatchStatus: "SKIPPED" }).level, "ATTENTION");
assert.equal(calculate(snapshot(), { ...healthy, sendTechnicalFailed: 1, sendFailed: 1 }).level, "ATTENTION");
assert.equal(
	calculate(snapshot(), { ...healthy, sendTechnicalFailed: 3, sendFailed: 3 }).level,
	"UNSTABLE",
	"a passed test cannot hide later real send failures"
);
assert.equal(
	calculate(snapshot(), { ...healthy, sendUnknown: 10 }).level,
	"ATTENTION",
	"uncertain sends are not proven delivery failures"
);
assert.equal(
	calculate(snapshot(), { ...healthy, sendMessageFailed: 10, sendFailed: 10 }).level,
	"STABLE",
	"recipient/content failures alone do not establish a broken channel"
);
assert.equal(calculate(snapshot(), { ...healthy, sendUnclassifiedFailed: 10, sendFailed: 10 }).level, "ATTENTION");
assert.equal(calculate(snapshot(), { ...healthy, receiveFailed: 1 }).level, "ATTENTION");
assert.equal(calculate(snapshot(), { ...healthy, receiveFailed: 3 }).level, "UNSTABLE");
assert.equal(
	calculate(snapshot(), { ...healthy, sendDelayed: 1, oldestSendPendingAt: new Date(now - 61_000).toISOString() })
		.level,
	"ATTENTION"
);
assert.equal(
	calculate(snapshot(), { ...healthy, sendDelayed: 1, oldestSendPendingAt: new Date(now - 301_000).toISOString() })
		.level,
	"UNSTABLE"
);
assert.equal(
	calculate(snapshot(), {
		...healthy,
		receiveDelayed: 5,
		oldestReceivePendingAt: new Date(now - 301_000).toISOString()
	}).level,
	"UNSTABLE"
);
for (const dataStatus of ["LIMITED", "UNAVAILABLE"] as const)
	assert.equal(calculate(snapshot(), { ...healthy, dataStatus }).level, "ATTENTION");
assert.equal(calculateSessionStability(snapshot(), 0, now, probe).level, "ATTENTION");
console.log("Session stability: functional checks, real messages, current state and incomplete observations passed");
