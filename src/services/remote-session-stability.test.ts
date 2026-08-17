import assert from "node:assert/strict";
import { calculateSessionStability, StabilitySnapshot } from "./remote-session-stability";

const now = Date.parse("2026-07-27T12:00:00.000Z");
const snapshot = (state: string, observedSecondsAgo = 0, stateSecondsAgo = 0, failures = 0): StabilitySnapshot => ({
	state,
	lastObservedAt: new Date(now - observedSecondsAgo * 1000),
	stateChangedAt: new Date(now - stateSecondsAgo * 1000),
	consecutivePollFailures: failures
});

assert.equal(calculateSessionStability(null, 0, now).level, "NO_DATA");
assert.equal(calculateSessionStability(snapshot("LOGGED_OUT"), 0, now).level, "LOGGED_OUT");
assert.equal(calculateSessionStability(snapshot("CONNECTED"), 1, now).level, "STABLE");
assert.equal(calculateSessionStability(snapshot("CONNECTED", 50), 0, now).level, "ATTENTION");
assert.equal(calculateSessionStability(snapshot("CONNECTED", 91), 0, now).level, "UNSTABLE");
assert.equal(calculateSessionStability(snapshot("CONNECTED"), 2, now).level, "ATTENTION");
assert.equal(calculateSessionStability(snapshot("CONNECTED"), 4, now).level, "UNSTABLE");
assert.equal(calculateSessionStability(snapshot("RECONNECTING"), 0, now).level, "ATTENTION");
assert.equal(calculateSessionStability(snapshot("DISCONNECTED", 0, 301), 0, now).level, "UNSTABLE");
assert.equal(calculateSessionStability(snapshot("CONNECTED", 0, 0, 3), 0, now).level, "UNSTABLE");

const passingProbe = {
	dispatchStatus: "PASSED" as const,
	receiveStatus: "PASSED" as const,
	expiresAt: new Date(now + 60_000).toISOString(),
	latencyMs: 1200,
	reason: "probe passed"
};
assert.deepEqual(calculateSessionStability(snapshot("CONNECTED"), 0, now, passingProbe), {
	level: "STABLE",
	reason: "Session is connected and passed the functional probe (1200ms)"
});
assert.equal(
	calculateSessionStability(snapshot("CONNECTED"), 0, now, {
		...passingProbe,
		receiveStatus: "FAILED",
		reason: "Shadow did not receive the event"
	}).level,
	"UNSTABLE"
);
assert.equal(
	calculateSessionStability(snapshot("CONNECTED"), 0, now, {
		...passingProbe,
		officialReceiveStatus: "FAILED",
		responseDispatchStatus: "SKIPPED",
		reason: "Official webhook did not receive the probe"
	}).level,
	"UNSTABLE"
);
assert.equal(
	calculateSessionStability(snapshot("CONNECTED"), 0, now, {
		...passingProbe,
		dispatchStatus: "SKIPPED",
		receiveStatus: "SKIPPED",
		reason: "Canary is not configured"
	}).level,
	"ATTENTION"
);
assert.equal(
	calculateSessionStability(snapshot("CONNECTED"), 0, now, {
		...passingProbe,
		expiresAt: new Date(now - 1).toISOString()
	}).level,
	"ATTENTION"
);

console.log("Remote session stability tests passed");
