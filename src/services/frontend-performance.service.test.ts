import assert from "node:assert/strict";
import { FrontendPerformanceRateLimiter } from "../middlewares/frontend-performance-rate-limit.middleware";
import {
	FrontendPerformanceValidationError,
	csvCell,
	normalizeFrontendRoute,
	parseFrontendPerformanceBatch,
	percentile,
	redactFrontendInstanceFromRoute
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
assert.equal(redactFrontendInstanceFromRoute("/api/instances/tenant-a/query", "tenant-a"), "/api/instances/:instance/query");
assert.equal(normalizeFrontendRoute("/api/customer/Maria_private"), "/api/customer/:value");
assert.equal(normalizeFrontendRoute("/api/customer-tenant-a/query"), "/api/:value/query");
assert.match(parsed.batchId, /^legacy-[0-9a-f]{56}$/);
assert.match(parsed.batchChecksum, /^[0-9a-f]{64}$/);
const sanitizedRoundTrip = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
delete sanitizedRoundTrip["batchId"];
delete sanitizedRoundTrip["batchChecksum"];
const canonicalA = parseFrontendPerformanceBatch({ ...sanitizedRoundTrip, ignored: "Maria private" });
const canonicalB = parseFrontendPerformanceBatch({ ignored: "Joana private", ...sanitizedRoundTrip });
assert.equal(canonicalA.batchChecksum, canonicalB.batchChecksum);
assert.equal(canonicalA.batchId, canonicalB.batchId);

const tenantSafe = parseFrontendPerformanceBatch({
	...parsed,
	startedAt: now,
	metrics: [{
		name: "api.duration",
		value: 20,
		unit: "ms",
		occurredAt: now,
		route: "/api/ai/tenant-config/tenant-a",
		tags: {
			endpoint: "/api/instances/tenant-a/query",
			errorMessage: "Mensagem privada de Maria",
			topFrame: "at Cliente Maria"
		}
	}]
}, "tenant-a");
assert.equal(tenantSafe.metrics[0]?.route, "/api/ai/tenant-config/:instance");
assert.deepEqual(tenantSafe.metrics[0]?.tags, { endpoint: "/api/instances/:instance/query" });
assert.equal(csvCell("=HYPERLINK(\"https://invalid\")"), '"\'=HYPERLINK(""https://invalid"")"');

const restrictedMetadata = parseFrontendPerformanceBatch({
	...parsed,
	startedAt: now,
	device: { ...parsed.device, browser: "=Nome privado", effectiveType: "empresa" },
	metrics: [{
		name: "render.count",
		value: 1,
		unit: "count",
		occurredAt: now,
		route: "/tenant-a/chats",
		tags: { component: "Maria", source: "cliente-privado", detailLevel: "detailed" }
	}]
});
assert.equal(restrictedMetadata.device.browser, "Unknown");
assert.equal(restrictedMetadata.device.effectiveType, null);
assert.deepEqual(restrictedMetadata.metrics[0]?.tags, { detailLevel: "detailed" });
for (const source of [
	"render_to_effect_sampled_1_in_20",
	"sampled_1_in_5_window_max",
	"sampled_1_in_10"
]) {
	const sampled = parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		metrics: [{
			name: "render.count",
			value: 1,
			unit: "count",
			occurredAt: now,
			route: "/tenant-a/chats",
			tags: { source }
		}]
	});
	assert.equal(sampled.metrics[0]?.tags?.["source"], source);
}
assert.throws(
	() => parseFrontendPerformanceBatch({ ...parsed, metrics: [{ name: "message.body", value: 1, unit: "count", occurredAt: now, route: "/x" }] }),
	(error) => error instanceof FrontendPerformanceValidationError && !error.message.includes("message.body")
);
assert.throws(
	() => parseFrontendPerformanceBatch({ ...parsed, buildId: "cliente-maria-performance", startedAt: now }),
	FrontendPerformanceValidationError
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		device: { ...parsed.device, hardwareConcurrency: 4.5 }
	}),
	FrontendPerformanceValidationError
);
assert.throws(
	() => parseFrontendPerformanceBatch({ ...parsed, startedAt: now, metrics: [null] }),
	FrontendPerformanceValidationError
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		metrics: [{ name: "interaction.cliente_maria", value: 10, unit: "ms", occurredAt: now, route: "/x" }]
	}),
	FrontendPerformanceValidationError
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: new Date(Date.now() - (31 * 24 * 60 * 60 * 1_000)).toISOString()
	}),
	FrontendPerformanceValidationError
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: new Date(Date.now() + (6 * 60 * 1_000)).toISOString()
	}),
	FrontendPerformanceValidationError
);

const runtimeMetrics = parseFrontendPerformanceBatch({
	...parsed,
	startedAt: now,
	metrics: [
		{ name: "runtime.frame_rate", value: 58, unit: "count", occurredAt: now, route: "/tenant-a/chats" },
		{ name: "runtime.frame_jank", value: 0.08, unit: "ratio", occurredAt: now, route: "/tenant-a/chats" },
		{ name: "runtime.event_loop_lag", value: 22, unit: "ms", occurredAt: now, route: "/tenant-a/chats" },
		{ name: "api.ttfb", value: 95, unit: "ms", occurredAt: now, route: "/tenant-a/chats" }
	]
});
assert.deepEqual(runtimeMetrics.metrics.map(({ name, unit }) => ({ name, unit })), [
	{ name: "runtime.frame_rate", unit: "count" },
	{ name: "runtime.frame_jank", unit: "ratio" },
	{ name: "runtime.event_loop_lag", unit: "ms" },
	{ name: "api.ttfb", unit: "ms" }
]);

const startupMetrics = parseFrontendPerformanceBatch({
	...parsed,
	startedAt: now,
	metrics: [{
		name: "startup.duration",
		value: 840,
		unit: "ms",
		occurredAt: now,
		route: "/tenant-a/chats?contact=Maria",
		tags: {
			phase: "chat_list_ready",
			outcome: "success",
			ignored: "Contato particular Maria"
		}
	}]
});
assert.equal(startupMetrics.metrics[0]?.name, "startup.duration");
assert.equal(startupMetrics.metrics[0]?.unit, "ms");
assert.equal(startupMetrics.metrics[0]?.route, "/:instance/chats");
assert.deepEqual(startupMetrics.metrics[0]?.tags, {
	phase: "chat_list_ready",
	outcome: "success"
});

const sanitizedStartupTags = parseFrontendPerformanceBatch({
	...parsed,
	startedAt: now,
	metrics: [{
		name: "startup.duration",
		value: 50,
		unit: "ms",
		occurredAt: now,
		route: "/tenant-a/chats",
		tags: { phase: "contact_Maria", outcome: "unknown", endpoint: "/api/instances/tenant-a/chats" }
	}]
}, "tenant-a");
assert.deepEqual(sanitizedStartupTags.metrics[0]?.tags, {
	endpoint: "/api/instances/:instance/chats"
});

assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		metrics: [{ name: "startup.duration", value: 100, unit: "count", occurredAt: now, route: "/x" }]
	}),
	(error) => error instanceof FrontendPerformanceValidationError && error.message.includes("startup.duration")
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		metrics: [{ name: "runtime.frame_rate", value: 58, unit: "ms", occurredAt: now, route: "/x" }]
	}),
	(error) => error instanceof FrontendPerformanceValidationError && error.message.includes("runtime.frame_rate")
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		metrics: [{ name: "api.ttfb", value: 95, unit: "count", occurredAt: now, route: "/x" }]
	}),
	(error) => error instanceof FrontendPerformanceValidationError && error.message.includes("api.ttfb")
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		metrics: [{ name: "runtime.cpu_percent", value: 50, unit: "ratio", occurredAt: now, route: "/x" }]
	}),
	FrontendPerformanceValidationError
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		metrics: [{ name: "api.duration", value: 86_400_001, unit: "ms", occurredAt: now, route: "/x" }]
	}),
	FrontendPerformanceValidationError
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		metrics: [{ name: "web_vital.lcp", value: 1200, unit: "bytes", occurredAt: now, route: "/x" }]
	}),
	FrontendPerformanceValidationError
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		metrics: [{ name: "api.duration", value: -1, unit: "ms", occurredAt: now, route: "/x" }]
	}),
	FrontendPerformanceValidationError
);
assert.throws(
	() => parseFrontendPerformanceBatch({
		...parsed,
		startedAt: now,
		metrics: [{ name: "runtime.frame_jank", value: 1.1, unit: "ratio", occurredAt: now, route: "/x" }]
	}),
	FrontendPerformanceValidationError
);

let rateLimitNow = 1_000;
const rateLimiter = new FrontendPerformanceRateLimiter(2, 60_000, () => rateLimitNow);
assert.equal(rateLimiter.consume("tenant-a", 10).allowed, true);
assert.equal(rateLimiter.consume("tenant-a", 10).allowed, true);
const limited = rateLimiter.consume("tenant-a", 10);
assert.equal(limited.allowed, false);
assert.equal(limited.remaining, 0);
assert.equal(limited.retryAfterSeconds, 60);

// Neither another user from the same tenant nor the same numeric user ID from
// another tenant shares the authenticated identity's bucket.
assert.equal(rateLimiter.consume("tenant-a", 11).allowed, true);
assert.equal(rateLimiter.consume("tenant-b", 10).allowed, true);

rateLimitNow += 60_000;
assert.equal(rateLimiter.consume("tenant-a", 10).allowed, true);
assert.equal(rateLimiter.consume("tenant-a", 10).remaining, 0);

console.log("frontend-performance.service tests passed");
