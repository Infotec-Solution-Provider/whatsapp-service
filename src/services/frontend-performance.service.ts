import { Prisma } from "@prisma/client";
import { Logger } from "@in.pulse-crm/utils";
import { createHash } from "node:crypto";
import cron from "node-cron";
import prismaService from "./prisma.service";

export const FRONTEND_PERFORMANCE_FLAG = "feature_frontend_performance_telemetry_enabled";
export const FRONTEND_PERFORMANCE_RETENTION_DAYS = 30;
export const FRONTEND_PERFORMANCE_MAX_BATCH_BYTES = 64 * 1024;
export const FRONTEND_PERFORMANCE_MAX_SAMPLES = 50;
const FRONTEND_PERFORMANCE_SUMMARY_RESERVOIR_SIZE = 2_048;
const FRONTEND_PERFORMANCE_SUMMARY_MAX_ROWS = 1_000_000;
const FRONTEND_PERFORMANCE_SUMMARY_MAX_BREAKDOWN_GROUPS_PER_METRIC = 100;
const FRONTEND_PERFORMANCE_RETENTION_SAMPLE_BATCH_SIZE = 10_000;
const FRONTEND_PERFORMANCE_RETENTION_RECEIPT_BATCH_SIZE = 10_000;
const FRONTEND_PERFORMANCE_RETENTION_SESSION_BATCH_SIZE = 1_000;

const METRIC_NAME_PATTERN =
	/^(web_vital\.(inp|lcp|cls|fcp|ttfb)|long_task\.(duration|total)|navigation\.duration|route_change\.duration|startup\.duration|interaction\.(chat_filter|chat_filter_ready|chat_sort|chat_sort_ready|open_chat|open_chat_ready|socket_event_ready)|render\.(count|duration|commit_latency)|api\.(duration|ttfb|transfer_bytes)|socket\.(event_count|handler_duration)|dom\.nodes|memory\.js_heap_bytes|runtime\.(frame_rate|frame_jank|event_loop_lag)|volume\.(chats_loaded|messages_loaded|chats_filtered|chats_sorted|messages_rendered)|file_send\.(duration|count|bytes|chunks)|error\.count|telemetry\.(flush_duration|dropped_samples)|resource\.(count|duration|transfer_bytes))$/;
const ALLOWED_UNITS = new Set(["ms", "bytes", "count", "ratio"]);
const METRIC_UNIT_RULES: Array<[RegExp, string]> = [
	[/^web_vital\.cls$/, "ratio"],
	[/^web_vital\.(inp|lcp|fcp|ttfb)$/, "ms"],
	[/^(long_task\.(duration|total)|navigation\.duration|route_change\.duration)$/, "ms"],
	[/^startup\.duration$/, "ms"],
	[/^interaction\.[a-z0-9_.-]+$/, "ms"],
	[/^render\.count$/, "count"],
	[/^render\.(duration|commit_latency)$/, "ms"],
	[/^api\.(duration|ttfb)$/, "ms"],
	[/^api\.transfer_bytes$/, "bytes"],
	[/^socket\.event_count$/, "count"],
	[/^socket\.handler_duration$/, "ms"],
	[/^dom\.nodes$/, "count"],
	[/^memory\.js_heap_bytes$/, "bytes"],
	[/^runtime\.frame_rate$/, "count"],
	[/^runtime\.frame_jank$/, "ratio"],
	[/^runtime\.event_loop_lag$/, "ms"],
	[/^volume\.(chats_loaded|messages_loaded|chats_filtered|chats_sorted|messages_rendered)$/, "count"],
	[/^file_send\.duration$/, "ms"],
	[/^file_send\.(count|chunks)$/, "count"],
	[/^file_send\.bytes$/, "bytes"],
	[/^error\.count$/, "count"],
	[/^telemetry\.flush_duration$/, "ms"],
	[/^telemetry\.dropped_samples$/, "count"],
	[/^resource\.count$/, "count"],
	[/^resource\.duration$/, "ms"],
	[/^resource\.transfer_bytes$/, "bytes"]
];
const ALLOWED_TAGS = new Set([
	"rating",
	"component",
	"interaction",
	"event",
	"endpoint",
	"statusClass",
	"initiatorType",
	"navigationType",
	"source",
	"phase",
	"outcome",
	"errorName",
	"errorFingerprint",
	"errorCategory",
	"errorSource",
	"errorCode",
	"detailLevel"
]);
const ALLOWED_COMPONENTS = new Set([
	"AppProvider",
	"ChatHeader",
	"ChatMessagesList",
	"ChatProvider",
	"ChatSendMessageArea",
	"ChatsMenuFilters",
	"ChatsMenuList",
	"ContactsProvider",
	"CustomersProvider",
	"Header",
	"InternalChatProvider",
	"InternalGroupsProvider",
	"ReadyMessagesProvider",
	"RenderInternalChatMessages",
	"RenderInternalGroupMessages",
	"RenderWhatsappChatMessages",
	"RouteFeatureGate",
	"SocketProvider",
	"WhatsappProvider"
]);
const ALLOWED_INTERACTIONS = new Set([
	"chat_filter",
	"chat_filter_ready",
	"chat_sort",
	"chat_sort_ready",
	"open_chat",
	"open_chat_ready",
	"socket_event_ready"
]);
const ALLOWED_SOCKET_EVENTS = new Set([
	"internal_chat_finished",
	"internal_chat_started",
	"internal_message",
	"internal_message_delete",
	"internal_message_edit",
	"internal_message_status",
	"report_status",
	"telephony_call_received",
	"wpp_chat_finished",
	"wpp_chat_started",
	"wpp_chat_transfer",
	"wpp_contact_messages_read",
	"wpp_message",
	"wpp_message_delete",
	"wpp_message_edit",
	"wpp_message_reaction",
	"wpp_message_status",
	"wwebjs_auth",
	"wwebjs_qr",
	"wwebjs_session_status"
]);
const ALLOWED_SOURCES = new Set([
	"1s_window",
	"1s_window_max",
	"10s_window",
	"30s_window",
	"30s_window_average",
	"30s_window_max",
	"30s_window_total",
	"axios_default",
	"axios_instance",
	"committed",
	"direction",
	"fetch",
	"field",
	"frames_per_second",
	"internal",
	"normalized_per_minute",
	"render_to_effect_sampled_1_in_10",
	"render_to_effect_sampled_1_in_20",
	"sampled_1_in_5",
	"sampled_1_in_5_window_max",
	"sampled_1_in_10",
	"search",
	"type",
	"whatsapp",
	"window_reservoir"
]);
const ALLOWED_ERROR_NAMES = new Set([
	"AbortError",
	"AggregateError",
	"AxiosError",
	"DOMException",
	"Error",
	"EvalError",
	"NetworkError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError"
]);
const ALLOWED_INITIATOR_TYPES = new Set([
	"audio",
	"beacon",
	"css",
	"fetch",
	"iframe",
	"img",
	"link",
	"navigation",
	"other",
	"script",
	"video",
	"xmlhttprequest"
]);
const ALLOWED_BUILD_LABELS = new Set(["development", "performance", "stable", "temp-stable-with-pannel"]);
const SAFE_TELEMETRY_ROUTE_SEGMENTS = new Set([
	":id",
	":instance",
	":value",
	"api",
	"ai",
	"ai-agents",
	"ai-settings",
	"ai-supervisor",
	"audio",
	"agents",
	"audience",
	"auth",
	"auth-batches",
	"auto-response",
	"auto-response-rules",
	"beacon",
	"browser-resource",
	"channels",
	"chat",
	"chats",
	"cities",
	"clients",
	"config",
	"copy",
	"contact-requests",
	"contacts",
	"css",
	"customer",
	"customers",
	"dashboard",
	"dashboards",
	"details",
	"execute",
	"execute-report-sql",
	"export",
	"export-report-sql",
	"fetch",
	"files",
	"filters",
	"finish",
	"flows",
	"full",
	"funnel",
	"generated",
	"geo",
	"goals-dashboard",
	"iframe",
	"img",
	"instances",
	"internal",
	"internal-groups",
	"items",
	"knowledge",
	"lead-origin-quality",
	"link",
	"login",
	"logs",
	"lost-reasons",
	"mailing-analysis",
	"marketing",
	"layout",
	"mass-messages",
	"messages",
	"metric-tables",
	"metrics",
	"monitor",
	"navigation",
	"new",
	"next",
	"notification-preferences",
	"notifications",
	"operator-performance",
	"operators",
	"other",
	"parameters",
	"preview",
	"public",
	"qr",
	"query",
	"read",
	"ready-messages",
	"regua-carteira-sintetico-whatsapp",
	"report-generator",
	"reports",
	"reports-history",
	"reset-qr",
	"restart",
	"retry",
	"sales",
	"save",
	"script",
	"sector",
	"sectors",
	"session",
	"session-monitor",
	"sessions",
	"sip-config",
	"states",
	"stream",
	"supervisor-chat",
	"team-goals",
	"templates",
	"tenant-config",
	"tools",
	"usage",
	"users",
	"video",
	"wallets",
	"whatsapp",
	"whatsapp-senders",
	"xmlhttprequest"
]);
const ENUMERATED_TAG_VALUES: Record<string, Set<string>> = {
	rating: new Set(["good", "needs-improvement", "poor"]),
	component: ALLOWED_COMPONENTS,
	interaction: ALLOWED_INTERACTIONS,
	event: ALLOWED_SOCKET_EVENTS,
	statusClass: new Set(["1xx", "2xx", "3xx", "4xx", "5xx", "cancelled", "network_error"]),
	initiatorType: ALLOWED_INITIATOR_TYPES,
	navigationType: new Set(["back_forward", "navigate", "prerender", "reload"]),
	source: ALLOWED_SOURCES,
	phase: new Set([
		"app_shell_ready",
		"session_ready",
		"parameters_ready",
		"initial_chats_ready",
		"chat_list_ready",
		"interactive_ready",
		"file_total",
		"file_hash",
		"file_dedupe",
		"file_upload_init",
		"file_upload_chunk",
		"file_upload_complete",
		"file_message_request"
	]),
	outcome: new Set(["success", "partial", "failed", "timeout", "aborted"]),
	errorName: ALLOWED_ERROR_NAMES,
	errorCategory: new Set(["aborted", "timeout", "chunk_load", "quota", "network", "syntax", "runtime"]),
	errorSource: new Set(["window_error", "unhandled_rejection", "api", "file_send"]),
	errorCode: new Set([
		"ECONNABORTED",
		"ETIMEDOUT",
		"ERR_BAD_REQUEST",
		"ERR_BAD_RESPONSE",
		"ERR_CANCELED",
		"ERR_NETWORK",
		"ERR_UPLOAD_TIMEOUT"
	]),
	detailLevel: new Set(["detailed", "light"])
};

interface RawDeviceData {
	browser?: unknown;
	hardwareConcurrency?: unknown;
	deviceMemoryGb?: unknown;
	effectiveType?: unknown;
	viewportWidth?: unknown;
	viewportHeight?: unknown;
}

interface RawMetricData {
	name?: unknown;
	value?: unknown;
	unit?: unknown;
	occurredAt?: unknown;
	route?: unknown;
	tags?: unknown;
}

export interface FrontendPerformanceBatch {
	schemaVersion: 1;
	batchId: string;
	batchChecksum: string;
	sessionId: string;
	buildId: string;
	startedAt: Date;
	device: {
		browser: string;
		hardwareConcurrency: number | null;
		deviceMemoryGb: number | null;
		effectiveType: string | null;
		viewportWidth: number;
		viewportHeight: number;
		deviceClass: "LOW" | "STANDARD" | "UNKNOWN";
	};
	metrics: Array<{
		name: string;
		value: number;
		unit: string;
		occurredAt: Date;
		route: string;
		tags: Prisma.InputJsonObject | null;
	}>;
}

export interface FrontendPerformanceFilters {
	from: Date;
	to: Date;
	name?: string;
	route?: string;
	buildId?: string;
	deviceClass?: string;
}

export class FrontendPerformanceValidationError extends Error {}

function validationError(message: string): never {
	throw new FrontendPerformanceValidationError(message);
}

function expectedMetricUnit(name: string): string | null {
	return METRIC_UNIT_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

function maximumMetricValue(name: string, unit: string): number {
	if (name === "runtime.frame_jank") return 1;
	if (name === "web_vital.cls") return 10;
	if (name === "runtime.frame_rate") return 1_000;
	if (unit === "ms") return 24 * 60 * 60 * 1_000;
	if (unit === "bytes") return 100 * 1024 * 1024 * 1024;
	if (unit === "count") return 10_000_000;
	return 10;
}

function boundedString(value: unknown, maxLength: number, field: string): string {
	if (typeof value !== "string") validationError(`${field} must be a string`);
	const normalized = value.trim();
	if (!normalized || normalized.length > maxLength) validationError(`${field} is invalid`);
	return normalized;
}

function optionalBoundedString(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().slice(0, maxLength);
	return normalized || null;
}

function normalizedBrowser(value: unknown): string {
	const browser = optionalBoundedString(value, 64);
	return browser && /^(Chrome|Edg|Firefox|Safari) \d{1,4}$/.test(browser) ? browser : "Unknown";
}

function normalizedEffectiveType(value: unknown): string | null {
	const effectiveType = optionalBoundedString(value, 16);
	return effectiveType && new Set(["slow-2g", "2g", "3g", "4g"]).has(effectiveType) ? effectiveType : null;
}

function normalizedBuildId(value: unknown): string {
	const buildId = boundedString(value, 64, "buildId").toLowerCase();
	if (ALLOWED_BUILD_LABELS.has(buildId)) return buildId;
	if (/^[0-9a-f]{7,64}$/.test(buildId)) return buildId;
	const [label, sha] = buildId.split(/[._-](?=[0-9a-f]{7,40}$)/, 2);
	if (label && sha && ALLOWED_BUILD_LABELS.has(label) && /^[0-9a-f]{7,40}$/.test(sha)) {
		return `${label}-${sha}`;
	}
	validationError("buildId is invalid");
}

function optionalPositiveNumber(value: unknown, max: number, field: string, integer = false): number | null {
	if (value === null || value === undefined) return null;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value <= 0 ||
		value > max ||
		(integer && !Number.isInteger(value))
	) {
		validationError(`${field} is invalid`);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

function positiveInteger(value: unknown, max: number, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
		validationError(`${field} is invalid`);
	}
	return value;
}

export function normalizeFrontendRoute(value: unknown): string {
	if (typeof value !== "string") return "/unknown";
	let path = value.split(/[?#]/, 1)[0] || "/unknown";
	try {
		if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
	} catch {
		path = "/unknown";
	}

	const rawSegments = path.split("/").filter(Boolean).slice(0, 12);
	const isApiRoute = rawSegments[0]?.toLowerCase() === "api";
	const segments = rawSegments.map((segment, index) => {
		if (!isApiRoute && index === 0) return ":instance";
		if (/^\d+$/.test(segment)) return ":id";
		if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":id";
		const normalized = segment
			.slice(0, 64)
			.replace(/[^a-zA-Z0-9_.:-]/g, "_")
			.toLowerCase();
		return SAFE_TELEMETRY_ROUTE_SEGMENTS.has(normalized) ? normalized : ":value";
	});

	return `/${segments.join("/")}`.slice(0, 255) || "/unknown";
}

export function redactFrontendInstanceFromRoute(value: unknown, instance: string): string {
	if (typeof value !== "string") return "/unknown";
	let path = value.split(/[?#]/, 1)[0] || "/unknown";
	try {
		if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
	} catch {
		path = "/unknown";
	}
	const candidates = new Set(
		[instance, encodeURIComponent(instance)]
			.map((candidate) => candidate.slice(0, 64).toLowerCase())
			.filter(Boolean)
	);
	const segments = path.split("/").map((segment) => (candidates.has(segment.toLowerCase()) ? ":instance" : segment));
	return normalizeFrontendRoute(segments.join("/"));
}

function sanitizeTags(value: unknown, trustedInstance?: string): Prisma.InputJsonObject | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const result: Record<string, Prisma.InputJsonValue> = {};

	for (const [key, rawValue] of Object.entries(value)) {
		if (!ALLOWED_TAGS.has(key)) continue;
		if (typeof rawValue !== "string") continue;

		if (key === "endpoint") {
			result[key] = trustedInstance
				? redactFrontendInstanceFromRoute(rawValue, trustedInstance)
				: normalizeFrontendRoute(rawValue);
		} else if (key === "errorFingerprint" && /^[0-9a-f]{8}$/i.test(rawValue)) {
			result[key] = rawValue.toLowerCase();
		} else if (ENUMERATED_TAG_VALUES[key]?.has(rawValue)) {
			result[key] = rawValue;
		}
	}

	return Object.keys(result).length > 0 ? (result as Prisma.InputJsonObject) : null;
}

function classifyDevice(hardwareConcurrency: number | null, deviceMemoryGb: number | null) {
	if (hardwareConcurrency === null && deviceMemoryGb === null) return "UNKNOWN" as const;
	if (
		(hardwareConcurrency !== null && hardwareConcurrency <= 4) ||
		(deviceMemoryGb !== null && deviceMemoryGb <= 4)
	) {
		return "LOW" as const;
	}
	return "STANDARD" as const;
}

export function parseFrontendPerformanceBatch(raw: unknown, trustedInstance?: string): FrontendPerformanceBatch {
	let serialized: string;
	try {
		serialized = JSON.stringify(raw ?? null);
	} catch {
		validationError("batch is invalid");
	}
	const serializedBytes = Buffer.byteLength(serialized, "utf8");
	if (serializedBytes > FRONTEND_PERFORMANCE_MAX_BATCH_BYTES) validationError("batch is too large");
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) validationError("batch is invalid");

	const input = raw as Record<string, unknown>;
	if (input["schemaVersion"] !== 1) validationError("schemaVersion is not supported");
	const providedBatchId = input["batchId"] === undefined ? null : boundedString(input["batchId"], 64, "batchId");
	if (
		providedBatchId &&
		!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|legacy-[0-9a-f]{56})$/i.test(
			providedBatchId
		)
	) {
		validationError("batchId is invalid");
	}
	const sessionId = boundedString(input["sessionId"], 36, "sessionId");
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
		validationError("sessionId is invalid");
	}
	const buildId = normalizedBuildId(input["buildId"]);
	const startedAt = new Date(boundedString(input["startedAt"], 40, "startedAt"));
	const now = Date.now();
	if (
		!Number.isFinite(startedAt.getTime()) ||
		startedAt.getTime() < now - FRONTEND_PERFORMANCE_RETENTION_DAYS * 24 * 60 * 60 * 1000 ||
		startedAt.getTime() > now + 5 * 60 * 1000
	) {
		validationError("startedAt is invalid");
	}

	const rawDevice = (input["device"] || {}) as RawDeviceData;
	const hardwareConcurrency = optionalPositiveNumber(rawDevice.hardwareConcurrency, 256, "hardwareConcurrency", true);
	const deviceMemoryGb = optionalPositiveNumber(rawDevice.deviceMemoryGb, 1024, "deviceMemoryGb");
	const device = {
		browser: normalizedBrowser(rawDevice.browser),
		hardwareConcurrency,
		deviceMemoryGb,
		effectiveType: normalizedEffectiveType(rawDevice.effectiveType),
		viewportWidth: positiveInteger(rawDevice.viewportWidth, 20000, "viewportWidth"),
		viewportHeight: positiveInteger(rawDevice.viewportHeight, 20000, "viewportHeight"),
		deviceClass: classifyDevice(hardwareConcurrency, deviceMemoryGb)
	};

	if (!Array.isArray(input["metrics"]) || input["metrics"].length === 0) validationError("metrics is required");
	if (input["metrics"].length > FRONTEND_PERFORMANCE_MAX_SAMPLES) validationError("too many metrics");

	const earliest = now - 24 * 60 * 60 * 1000;
	const latest = now + 5 * 60 * 1000;
	const metrics = (input["metrics"] as RawMetricData[]).map((metric) => {
		if (!metric || typeof metric !== "object" || Array.isArray(metric)) {
			validationError("metric is invalid");
		}
		const name = boundedString(metric.name, 64, "metric.name");
		if (!METRIC_NAME_PATTERN.test(name)) validationError("metric name is not allowed");
		if (typeof metric.value !== "number" || !Number.isFinite(metric.value) || metric.value < 0) {
			validationError("metric.value is invalid");
		}
		const unit = boundedString(metric.unit, 16, "metric.unit");
		if (!ALLOWED_UNITS.has(unit)) validationError("metric.unit is invalid");
		const expectedUnit = expectedMetricUnit(name);
		if (!expectedUnit || unit !== expectedUnit) validationError(`metric.unit is invalid for ${name}`);
		if (metric.value > maximumMetricValue(name, unit)) validationError(`metric.value is invalid for ${name}`);
		if (unit === "count" && name !== "runtime.frame_rate" && !Number.isInteger(metric.value)) {
			validationError(`metric.value is invalid for ${name}`);
		}
		const occurredAt = new Date(boundedString(metric.occurredAt, 40, "metric.occurredAt"));
		if (
			!Number.isFinite(occurredAt.getTime()) ||
			occurredAt.getTime() < earliest ||
			occurredAt.getTime() > latest
		) {
			validationError("metric.occurredAt is outside the accepted window");
		}

		const route = trustedInstance
			? redactFrontendInstanceFromRoute(metric.route, trustedInstance)
			: normalizeFrontendRoute(metric.route);
		const tags = sanitizeTags(metric.tags, trustedInstance);

		return {
			name,
			value: metric.value,
			unit,
			occurredAt,
			route,
			tags
		};
	});
	const batchChecksum = createHash("sha256")
		.update(
			canonicalJson({
				schemaVersion: 1,
				sessionId,
				buildId,
				startedAt,
				device,
				metrics
			})
		)
		.digest("hex");
	const batchId = providedBatchId ?? `legacy-${batchChecksum.slice(0, 56)}`;

	return {
		schemaVersion: 1,
		batchId: batchId.toLowerCase(),
		batchChecksum,
		sessionId,
		buildId,
		startedAt,
		device,
		metrics
	};
}

export function percentile(values: number[], ratio: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor((sorted.length - 1) * ratio)] ?? null;
}

interface SummaryAccumulator {
	count: number;
	max: number | null;
	randomState: number;
	values: number[];
}

interface SamplePageCursor {
	id: bigint;
	occurredAt: Date;
}

function summarySeed(key: string): number {
	let hash = 2166136261;
	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function createSummaryAccumulator(key: string): SummaryAccumulator {
	return { count: 0, max: null, randomState: summarySeed(key), values: [] };
}

function addSummaryValue(accumulator: SummaryAccumulator, value: number) {
	accumulator.count += 1;
	accumulator.max = accumulator.max === null ? value : Math.max(accumulator.max, value);
	if (accumulator.values.length < FRONTEND_PERFORMANCE_SUMMARY_RESERVOIR_SIZE) {
		accumulator.values.push(value);
		return;
	}

	accumulator.randomState = (Math.imul(accumulator.randomState, 1664525) + 1013904223) >>> 0;
	const candidateIndex = accumulator.randomState % accumulator.count;
	if (candidateIndex < FRONTEND_PERFORMANCE_SUMMARY_RESERVOIR_SIZE) {
		accumulator.values[candidateIndex] = value;
	}
}

function summarizeAccumulator(accumulator: SummaryAccumulator) {
	return {
		count: accumulator.count,
		p50: percentile(accumulator.values, 0.5),
		p75: percentile(accumulator.values, 0.75),
		p95: percentile(accumulator.values, 0.95),
		max: accumulator.max,
		sampledValues: accumulator.values.length,
		approximate: accumulator.count > accumulator.values.length
	};
}

function breakdownAccumulator(
	map: Map<string, SummaryAccumulator>,
	key: string,
	fallbackKey: string,
	groupCounts: Map<string, number>
): SummaryAccumulator {
	const existing = map.get(key);
	if (existing) return existing;
	const metricName = key.split("\u0000", 1)[0] || "unknown";
	const metricGroupCount = groupCounts.get(metricName) ?? 0;
	const effectiveKey =
		metricGroupCount < FRONTEND_PERFORMANCE_SUMMARY_MAX_BREAKDOWN_GROUPS_PER_METRIC ? key : fallbackKey;
	const fallback = map.get(effectiveKey);
	if (fallback) return fallback;
	const created = createSummaryAccumulator(effectiveKey);
	map.set(effectiveKey, created);
	if (effectiveKey === key) groupCounts.set(metricName, metricGroupCount + 1);
	return created;
}

export function csvCell(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
	return `"${safeText.replace(/"/g, '""')}"`;
}

class FrontendPerformanceService {
	private retentionStarted = false;
	private retentionRunning = false;

	public async ingest(instance: string, userId: number, batch: FrontendPerformanceBatch) {
		return prismaService.$transaction(async (transaction) => {
			const session = await transaction.frontendPerformanceSession.upsert({
				where: { instance_userId_sessionId: { instance, userId, sessionId: batch.sessionId } },
				create: {
					instance,
					userId,
					sessionId: batch.sessionId,
					buildId: batch.buildId,
					deviceClass: batch.device.deviceClass,
					browser: batch.device.browser,
					hardwareConcurrency: batch.device.hardwareConcurrency,
					deviceMemoryGb: batch.device.deviceMemoryGb,
					effectiveType: batch.device.effectiveType,
					viewportWidth: batch.device.viewportWidth,
					viewportHeight: batch.device.viewportHeight,
					startedAt: batch.startedAt,
					lastSeenAt: new Date()
				},
				update: { sessionId: batch.sessionId }
			});

			if (
				session.buildId !== batch.buildId ||
				session.startedAt.getTime() !== batch.startedAt.getTime() ||
				session.deviceClass !== batch.device.deviceClass ||
				session.browser !== batch.device.browser ||
				session.hardwareConcurrency !== batch.device.hardwareConcurrency ||
				session.deviceMemoryGb !== batch.device.deviceMemoryGb ||
				session.effectiveType !== batch.device.effectiveType ||
				session.viewportWidth !== batch.device.viewportWidth ||
				session.viewportHeight !== batch.device.viewportHeight
			) {
				validationError("session metadata does not match the original telemetry session");
			}
			await transaction.$executeRaw`
				UPDATE frontend_performance_sessions
				SET last_seen_at = CURRENT_TIMESTAMP(3)
				WHERE id = ${session.id}
			`;

			const receipt = await transaction.frontendPerformanceBatchReceipt.createMany({
				data: [
					{
						sessionDbId: session.id,
						batchId: batch.batchId,
						checksum: batch.batchChecksum
					}
				],
				skipDuplicates: true
			});
			if (receipt.count === 0) {
				const existing = await transaction.frontendPerformanceBatchReceipt.findUnique({
					where: { sessionDbId_batchId: { sessionDbId: session.id, batchId: batch.batchId } }
				});
				if (!existing || existing.checksum !== batch.batchChecksum) {
					validationError("batchId was already used with different telemetry data");
				}
				return { accepted: 0, duplicate: true };
			}

			const inserted = await transaction.frontendPerformanceSample.createMany({
				data: batch.metrics.map((metric, sampleIndex) => ({
					sessionId: session.id,
					batchId: batch.batchId,
					sampleIndex,
					instance,
					name: metric.name,
					value: metric.value,
					unit: metric.unit,
					route: metric.route,
					tags: metric.tags ?? Prisma.JsonNull,
					occurredAt: metric.occurredAt
				}))
			});

			return { accepted: inserted.count, duplicate: false };
		});
	}

	private sampleConditions(
		filters: FrontendPerformanceFilters,
		highWaterMark?: bigint
	): Prisma.FrontendPerformanceSampleWhereInput {
		return {
			...(highWaterMark !== undefined ? { id: { lte: highWaterMark } } : {}),
			occurredAt: { gte: filters.from, lte: filters.to },
			...(filters.name ? { name: filters.name } : {}),
			...(filters.route ? { route: normalizeFrontendRoute(filters.route) } : {})
		};
	}

	private sampleWhere(
		instance: string,
		filters: FrontendPerformanceFilters,
		highWaterMark?: bigint
	): Prisma.FrontendPerformanceSampleWhereInput {
		return {
			instance,
			...this.sampleConditions(filters, highWaterMark),
			session: {
				...(filters.buildId ? { buildId: filters.buildId } : {}),
				...(filters.deviceClass ? { deviceClass: filters.deviceClass } : {})
			}
		};
	}

	private sessionWhere(
		instance: string,
		filters: FrontendPerformanceFilters,
		highWaterMark?: bigint
	): Prisma.FrontendPerformanceSessionWhereInput {
		return {
			instance,
			...(filters.buildId ? { buildId: filters.buildId } : {}),
			...(filters.deviceClass ? { deviceClass: filters.deviceClass } : {}),
			samples: { some: { instance, ...this.sampleConditions(filters, highWaterMark) } }
		};
	}

	private paginatedSampleWhere(
		instance: string,
		filters: FrontendPerformanceFilters,
		cursor?: SamplePageCursor,
		highWaterMark?: bigint
	): Prisma.FrontendPerformanceSampleWhereInput {
		const base = this.sampleWhere(instance, filters, highWaterMark);
		if (!cursor) return base;
		return {
			AND: [
				base,
				{
					OR: [
						{ occurredAt: { gt: cursor.occurredAt } },
						{ occurredAt: cursor.occurredAt, id: { gt: cursor.id } }
					]
				}
			]
		};
	}

	public async summary(instance: string, filters: FrontendPerformanceFilters) {
		const metricValues = new Map<string, { name: string; unit: string; summary: SummaryAccumulator }>();
		const routeValues = new Map<string, SummaryAccumulator>();
		const deviceValues = new Map<string, SummaryAccumulator>();
		const buildValues = new Map<string, SummaryAccumulator>();
		const routeGroupCounts = new Map<string, number>();
		const deviceGroupCounts = new Map<string, number>();
		const buildGroupCounts = new Map<string, number>();
		const snapshot = await prismaService.frontendPerformanceSample.findFirst({
			where: this.sampleWhere(instance, filters),
			select: { id: true },
			orderBy: { id: "desc" }
		});
		const highWaterMark = snapshot?.id ?? 0n;
		const totalSampleCount = await prismaService.frontendPerformanceSample.count({
			where: this.sampleWhere(instance, filters, highWaterMark)
		});
		if (totalSampleCount > FRONTEND_PERFORMANCE_SUMMARY_MAX_ROWS) {
			validationError("summary query has too many samples; narrow the filters");
		}
		const sessionCount = await prismaService.frontendPerformanceSession.count({
			where: this.sessionWhere(instance, filters, highWaterMark)
		});
		const pageSize = 10_000;
		let cursor: SamplePageCursor | undefined;
		let sampleCount = 0;
		let truncated = false;
		let reachedLimit = false;

		while (true) {
			const remaining = FRONTEND_PERFORMANCE_SUMMARY_MAX_ROWS - sampleCount;
			const take = Math.min(pageSize, remaining + 1);
			const samples = await prismaService.frontendPerformanceSample.findMany({
				where: this.paginatedSampleWhere(instance, filters, cursor, highWaterMark),
				select: {
					id: true,
					occurredAt: true,
					name: true,
					value: true,
					unit: true,
					route: true,
					session: { select: { deviceClass: true, buildId: true } }
				},
				orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
				take
			});
			if (samples.length === 0) break;
			const samplesToProcess = samples.slice(0, remaining);
			if (samples.length > samplesToProcess.length) {
				truncated = true;
				reachedLimit = true;
			}

			for (const sample of samplesToProcess) {
				const metricKey = `${sample.name}\u0000${sample.unit}`;
				const metric = metricValues.get(metricKey) || {
					name: sample.name,
					unit: sample.unit,
					summary: createSummaryAccumulator(metricKey)
				};
				addSummaryValue(metric.summary, sample.value);
				metricValues.set(metricKey, metric);

				const dimensions: Array<[Map<string, SummaryAccumulator>, string, Map<string, number>]> = [
					[routeValues, `${sample.name}\u0000${sample.route}`, routeGroupCounts],
					[deviceValues, `${sample.name}\u0000${sample.session.deviceClass}`, deviceGroupCounts],
					[buildValues, `${sample.name}\u0000${sample.session.buildId}`, buildGroupCounts]
				];
				for (const [map, key, groupCounts] of dimensions) {
					addSummaryValue(
						breakdownAccumulator(map, key, `${sample.name}\u0000:other`, groupCounts),
						sample.value
					);
				}
			}

			sampleCount += samplesToProcess.length;
			const lastSample = samplesToProcess[samplesToProcess.length - 1];
			if (lastSample) cursor = { id: lastSample.id, occurredAt: lastSample.occurredAt };
			if (reachedLimit || samples.length < take || !cursor) break;
		}

		const breakdown = (map: Map<string, SummaryAccumulator>, dimension: string) =>
			[...map.entries()].map(([key, summary]) => {
				const [name = "unknown", value = "unknown"] = key.split("\u0000");
				return { name, [dimension]: value, ...summarizeAccumulator(summary) };
			});
		const breakdownsGroupedAsOther = [routeValues, deviceValues, buildValues].some((map) =>
			[...map.keys()].some((key) => key.endsWith("\u0000:other"))
		);
		const approximate =
			truncated ||
			breakdownsGroupedAsOther ||
			[...metricValues.values()].some(({ summary }) => summary.count > summary.values.length);

		return {
			from: filters.from,
			to: filters.to,
			highWaterMark: highWaterMark.toString(),
			truncated,
			sampleLimit: FRONTEND_PERFORMANCE_SUMMARY_MAX_ROWS,
			approximate,
			breakdownsGroupedAsOther,
			sessions: sessionCount,
			samples: totalSampleCount,
			samplesProcessed: sampleCount,
			metrics: [...metricValues.values()].map((metric) => ({
				name: metric.name,
				unit: metric.unit,
				...summarizeAccumulator(metric.summary)
			})),
			breakdowns: {
				routes: breakdown(routeValues, "route"),
				devices: breakdown(deviceValues, "deviceClass"),
				builds: breakdown(buildValues, "buildId")
			}
		};
	}

	public async *exportCsvChunks(instance: string, filters: FrontendPerformanceFilters): AsyncGenerator<string> {
		const header = [
			"sample_id",
			"batch_id",
			"sample_index",
			"occurred_at",
			"session_id",
			"user_id",
			"build_id",
			"device_class",
			"browser",
			"hardware_concurrency",
			"device_memory_gb",
			"effective_type",
			"viewport_width",
			"viewport_height",
			"route",
			"metric",
			"value",
			"unit",
			"tags"
		];
		const pageSize = 5_000;
		let cursor: SamplePageCursor | undefined;
		const snapshot = await prismaService.frontendPerformanceSample.findFirst({
			where: this.sampleWhere(instance, filters),
			select: { id: true },
			orderBy: { id: "desc" }
		});
		const highWaterMark = snapshot?.id ?? 0n;
		const loadPage = () =>
			prismaService.frontendPerformanceSample.findMany({
				where: this.paginatedSampleWhere(instance, filters, cursor, highWaterMark),
				include: { session: true },
				orderBy: [{ occurredAt: "asc" as const }, { id: "asc" as const }],
				take: pageSize
			});
		let samples = await loadPage();
		yield `${header.map(csvCell).join(",")}\n`;

		while (true) {
			if (samples.length === 0) break;
			const rows = samples.map((sample) => [
				sample.id.toString(),
				sample.batchId,
				sample.sampleIndex,
				sample.occurredAt.toISOString(),
				sample.session.sessionId,
				sample.session.userId,
				sample.session.buildId,
				sample.session.deviceClass,
				sample.session.browser,
				sample.session.hardwareConcurrency,
				sample.session.deviceMemoryGb,
				sample.session.effectiveType,
				sample.session.viewportWidth,
				sample.session.viewportHeight,
				sample.route,
				sample.name,
				sample.value,
				sample.unit,
				sample.tags ? JSON.stringify(sample.tags) : ""
			]);
			yield `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
			const lastSample = samples[samples.length - 1];
			if (!lastSample || samples.length < pageSize) break;
			cursor = { id: lastSample.id, occurredAt: lastSample.occurredAt };
			samples = await loadPage();
		}
	}

	public async purgeExpired() {
		if (this.retentionRunning) return { samples: 0, receipts: 0, sessions: 0, skipped: true };
		this.retentionRunning = true;
		const cutoff = new Date(Date.now() - FRONTEND_PERFORMANCE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
		let deletedSamples = 0;
		let deletedReceipts = 0;
		let deletedSessions = 0;
		try {
			while (true) {
				const expired = await prismaService.frontendPerformanceSample.findMany({
					where: { occurredAt: { lt: cutoff } },
					select: { id: true },
					orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
					take: FRONTEND_PERFORMANCE_RETENTION_SAMPLE_BATCH_SIZE
				});
				if (expired.length === 0) break;
				const deleted = await prismaService.frontendPerformanceSample.deleteMany({
					where: { id: { in: expired.map(({ id }) => id) } }
				});
				deletedSamples += deleted.count;
				if (expired.length < FRONTEND_PERFORMANCE_RETENTION_SAMPLE_BATCH_SIZE) break;
			}

			while (true) {
				const expired = await prismaService.frontendPerformanceBatchReceipt.findMany({
					where: { createdAt: { lt: cutoff } },
					select: { id: true },
					orderBy: [{ createdAt: "asc" }, { id: "asc" }],
					take: FRONTEND_PERFORMANCE_RETENTION_RECEIPT_BATCH_SIZE
				});
				if (expired.length === 0) break;
				const deleted = await prismaService.frontendPerformanceBatchReceipt.deleteMany({
					where: { id: { in: expired.map(({ id }) => id) } }
				});
				deletedReceipts += deleted.count;
				if (expired.length < FRONTEND_PERFORMANCE_RETENTION_RECEIPT_BATCH_SIZE) break;
			}

			while (true) {
				const emptySessions = await prismaService.frontendPerformanceSession.findMany({
					where: { samples: { none: {} }, lastSeenAt: { lt: cutoff } },
					select: { id: true },
					orderBy: [{ lastSeenAt: "asc" }, { id: "asc" }],
					take: FRONTEND_PERFORMANCE_RETENTION_SESSION_BATCH_SIZE
				});
				if (emptySessions.length === 0) break;
				const deleted = await prismaService.frontendPerformanceSession.deleteMany({
					// Reapply the eligibility conditions at deletion time. An ingest may
					// reactivate a session between the read and this statement.
					where: {
						id: { in: emptySessions.map(({ id }) => id) },
						lastSeenAt: { lt: cutoff },
						samples: { none: {} }
					}
				});
				deletedSessions += deleted.count;
				if (emptySessions.length < FRONTEND_PERFORMANCE_RETENTION_SESSION_BATCH_SIZE) break;
			}

			return { samples: deletedSamples, receipts: deletedReceipts, sessions: deletedSessions, skipped: false };
		} finally {
			this.retentionRunning = false;
		}
	}

	public startRetentionRoutine() {
		if (this.retentionStarted) return;
		this.retentionStarted = true;
		cron.schedule("17 3 * * *", () => {
			void this.purgeExpired().catch((error: unknown) => {
				Logger.error("Failed to purge expired frontend performance samples", error as Error);
			});
		});
	}
}

export default new FrontendPerformanceService();
