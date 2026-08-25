import assert from "node:assert/strict";
import {
	FrontendPerformanceValidationError,
	normalizeFrontendRoute,
	parseFrontendPerformanceBatch,
	percentile,
	sanitizeFrontendErrorMessage
} from "./frontend-performance.service";

const now = new Date().toISOString();
const parsed = parseFrontendPerformanceBatch({
	schemaVersion: 1,
	sessionId: "3d594650-3436-4c41-9360-3bf64af50f1a",
	buildId: "b451e51",
	startedAt: now,
	device: {
		browser: "Chrome 140",
		hardwareConcurrency: 4,
		deviceMemoryGb: 4,
		effectiveType: "4g",
		viewportWidth: 1366,
		viewportHeight: 768
	},
	metrics: [{
		name: "web_vital.inp",
		value: 180,
		unit: "ms",
		occurredAt: now,
		route: "/tenant-a/contacts/123?token=secret",
		tags: { rating: "good", ignored: "contact name" }
	}]
});

assert.equal(parsed.device.deviceClass, "LOW");
assert.equal(parsed.metrics[0]?.route, "/:instance/contacts/:id");
assert.deepEqual(parsed.metrics[0]?.tags, { rating: "good" });
assert.equal(percentile([100, 400, 200, 300], 0.75), 300);
assert.equal(normalizeFrontendRoute("/acme/chat/42?phone=555199999999"), "/:instance/chat/:id");
assert.equal(
	sanitizeFrontendErrorMessage("Failed for renan@example.com at https://example.com/a?token=123"),
	"Failed for [email] at [url]"
);
assert.throws(
	() => parseFrontendPerformanceBatch({ ...parsed, metrics: [{ name: "message.body", value: 1, unit: "count", occurredAt: now, route: "/x" }] }),
	FrontendPerformanceValidationError
);

console.log("frontend-performance.service tests passed");
