import { Prisma } from "@prisma/client";
import { Logger } from "@in.pulse-crm/utils";
import cron from "node-cron";
import prismaService from "./prisma.service";

export const FRONTEND_PERFORMANCE_FLAG = "feature_frontend_performance_telemetry_enabled";
export const FRONTEND_PERFORMANCE_RETENTION_DAYS = 30;
export const FRONTEND_PERFORMANCE_MAX_BATCH_BYTES = 64 * 1024;
export const FRONTEND_PERFORMANCE_MAX_SAMPLES = 50;

const METRIC_NAME_PATTERN = /^(web_vital\.(inp|lcp|cls|fcp|ttfb)|long_task\.(duration|total)|navigation\.duration|route_change\.duration|interaction\.[a-z0-9_.-]+|render\.(count|duration)|api\.(duration|transfer_bytes)|socket\.(event_count|handler_duration)|dom\.nodes|memory\.js_heap_bytes|error\.count|telemetry\.flush_duration|resource\.(duration|transfer_bytes))$/;
const ALLOWED_UNITS = new Set(["ms", "bytes", "count", "ratio"]);
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
	"errorName",
	"errorMessage",
	"errorFingerprint",
	"topFrame",
	"detailLevel"
]);

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

function optionalPositiveNumber(value: unknown, max: number): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) return null;
	return value;
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

	const segments = path
		.split("/")
		.filter(Boolean)
		.slice(0, 12)
		.map((segment) => {
			if (/^\d+$/.test(segment)) return ":id";
			if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":id";
			return segment.slice(0, 64).replace(/[^a-zA-Z0-9_.:-]/g, "_");
		});

	if (segments.length > 0 && segments[0] !== "api") segments[0] = ":instance";
	return `/${segments.join("/")}`.slice(0, 255) || "/unknown";
}

export function sanitizeFrontendErrorMessage(value: string): string {
	return value
		.replace(/https?:\/\/[^\s]+/gi, "[url]")
		.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
		.replace(/\b(?:bearer\s+)?[a-z0-9_-]{24,}\b/gi, "[secret]")
		.replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
		.slice(0, 240);
}

function sanitizeTags(value: unknown): Prisma.InputJsonObject | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const result: Record<string, Prisma.InputJsonValue> = {};

	for (const [key, rawValue] of Object.entries(value)) {
		if (!ALLOWED_TAGS.has(key)) continue;
		if (typeof rawValue === "number" && Number.isFinite(rawValue)) result[key] = rawValue;
		if (typeof rawValue === "boolean") result[key] = rawValue;
		if (typeof rawValue !== "string") continue;

		if (key === "endpoint") result[key] = normalizeFrontendRoute(rawValue);
		else if (key === "errorMessage" || key === "topFrame") result[key] = sanitizeFrontendErrorMessage(rawValue);
		else result[key] = rawValue.slice(0, key === "topFrame" ? 180 : 96);
	}

	return Object.keys(result).length > 0 ? result as Prisma.InputJsonObject : null;
}

function classifyDevice(hardwareConcurrency: number | null, deviceMemoryGb: number | null) {
	if (hardwareConcurrency === null && deviceMemoryGb === null) return "UNKNOWN" as const;
	if ((hardwareConcurrency !== null && hardwareConcurrency <= 4) || (deviceMemoryGb !== null && deviceMemoryGb <= 4)) {
		return "LOW" as const;
	}
	return "STANDARD" as const;
}

export function parseFrontendPerformanceBatch(raw: unknown): FrontendPerformanceBatch {
	const serializedBytes = Buffer.byteLength(JSON.stringify(raw ?? null), "utf8");
	if (serializedBytes > FRONTEND_PERFORMANCE_MAX_BATCH_BYTES) validationError("batch is too large");
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) validationError("batch is invalid");

	const input = raw as Record<string, unknown>;
	if (input["schemaVersion"] !== 1) validationError("schemaVersion is not supported");
	const sessionId = boundedString(input["sessionId"], 36, "sessionId");
	if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId)) validationError("sessionId is invalid");
	const buildId = boundedString(input["buildId"], 64, "buildId").replace(/[^a-zA-Z0-9_.-]/g, "_");
	const startedAt = new Date(boundedString(input["startedAt"], 40, "startedAt"));
	if (!Number.isFinite(startedAt.getTime())) validationError("startedAt is invalid");

	const rawDevice = (input["device"] || {}) as RawDeviceData;
	const hardwareConcurrency = optionalPositiveNumber(rawDevice.hardwareConcurrency, 256);
	const deviceMemoryGb = optionalPositiveNumber(rawDevice.deviceMemoryGb, 1024);
	const device = {
		browser: optionalBoundedString(rawDevice.browser, 64) || "Unknown",
		hardwareConcurrency,
		deviceMemoryGb,
		effectiveType: optionalBoundedString(rawDevice.effectiveType, 16),
		viewportWidth: positiveInteger(rawDevice.viewportWidth, 20000, "viewportWidth"),
		viewportHeight: positiveInteger(rawDevice.viewportHeight, 20000, "viewportHeight"),
		deviceClass: classifyDevice(hardwareConcurrency, deviceMemoryGb)
	};

	if (!Array.isArray(input["metrics"]) || input["metrics"].length === 0) validationError("metrics is required");
	if (input["metrics"].length > FRONTEND_PERFORMANCE_MAX_SAMPLES) validationError("too many metrics");

	const earliest = Date.now() - 24 * 60 * 60 * 1000;
	const latest = Date.now() + 5 * 60 * 1000;
	const metrics = (input["metrics"] as RawMetricData[]).map((metric) => {
		const name = boundedString(metric.name, 64, "metric.name");
		if (!METRIC_NAME_PATTERN.test(name)) validationError(`metric name is not allowed: ${name}`);
		if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) validationError("metric.value is invalid");
		const unit = boundedString(metric.unit, 16, "metric.unit");
		if (!ALLOWED_UNITS.has(unit)) validationError("metric.unit is invalid");
		const occurredAt = new Date(boundedString(metric.occurredAt, 40, "metric.occurredAt"));
		if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() < earliest || occurredAt.getTime() > latest) {
			validationError("metric.occurredAt is outside the accepted window");
		}

		return {
			name,
			value: metric.value,
			unit,
			occurredAt,
			route: normalizeFrontendRoute(metric.route),
			tags: sanitizeTags(metric.tags)
		};
	});

	return { schemaVersion: 1, sessionId, buildId, startedAt, device, metrics };
}

export function percentile(values: number[], ratio: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor((sorted.length - 1) * ratio)] ?? null;
}

function summarizeValues(values: number[]) {
	return {
		count: values.length,
		p50: percentile(values, 0.5),
		p75: percentile(values, 0.75),
		p95: percentile(values, 0.95),
		max: values.length ? Math.max(...values) : null
	};
}

function csvCell(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	return `"${text.replace(/"/g, '""')}"`;
}

class FrontendPerformanceService {
	private retentionStarted = false;

	public async ingest(instance: string, userId: number, batch: FrontendPerformanceBatch) {
		const now = new Date();
		const session = await prismaService.frontendPerformanceSession.upsert({
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
				lastSeenAt: now
			},
			update: { lastSeenAt: now, buildId: batch.buildId }
		});

		await prismaService.frontendPerformanceSample.createMany({
			data: batch.metrics.map((metric) => ({
				sessionId: session.id,
				instance,
				name: metric.name,
				value: metric.value,
				unit: metric.unit,
				route: metric.route,
				tags: metric.tags ?? Prisma.JsonNull,
				occurredAt: metric.occurredAt
			}))
		});

		return { accepted: batch.metrics.length };
	}

	private sampleWhere(instance: string, filters: FrontendPerformanceFilters): Prisma.FrontendPerformanceSampleWhereInput {
		return {
			instance,
			occurredAt: { gte: filters.from, lte: filters.to },
			...(filters.name ? { name: filters.name } : {}),
			...(filters.route ? { route: normalizeFrontendRoute(filters.route) } : {}),
			session: {
				...(filters.buildId ? { buildId: filters.buildId } : {}),
				...(filters.deviceClass ? { deviceClass: filters.deviceClass } : {})
			}
		};
	}

	public async summary(instance: string, filters: FrontendPerformanceFilters) {
		const samples = await prismaService.frontendPerformanceSample.findMany({
			where: this.sampleWhere(instance, filters),
			select: {
				name: true,
				value: true,
				unit: true,
				route: true,
				session: { select: { id: true, deviceClass: true, buildId: true } }
			},
			orderBy: { occurredAt: "asc" },
			take: 100_000
		});

		const metricValues = new Map<string, { name: string; unit: string; values: number[] }>();
		const routeValues = new Map<string, number[]>();
		const deviceValues = new Map<string, number[]>();
		const buildValues = new Map<string, number[]>();
		const sessionIds = new Set<number>();

		for (const sample of samples) {
			sessionIds.add(sample.session.id);
			const metricKey = `${sample.name}\u0000${sample.unit}`;
			const metric = metricValues.get(metricKey) || { name: sample.name, unit: sample.unit, values: [] };
			metric.values.push(sample.value);
			metricValues.set(metricKey, metric);

			const dimensions: Array<[Map<string, number[]>, string]> = [
				[routeValues, `${sample.name}\u0000${sample.route}`],
				[deviceValues, `${sample.name}\u0000${sample.session.deviceClass}`],
				[buildValues, `${sample.name}\u0000${sample.session.buildId}`]
			];
			for (const [map, key] of dimensions) {
				const values = map.get(key);
				if (values) values.push(sample.value);
				else map.set(key, [sample.value]);
			}
		}

		const breakdown = (map: Map<string, number[]>, dimension: string) =>
			[...map.entries()].map(([key, values]) => {
				const [name = "unknown", value = "unknown"] = key.split("\u0000");
				return { name, [dimension]: value, ...summarizeValues(values) };
			});

		return {
			from: filters.from,
			to: filters.to,
			truncated: samples.length === 100_000,
			sessions: sessionIds.size,
			samples: samples.length,
			metrics: [...metricValues.values()].map((metric) => ({
				name: metric.name,
				unit: metric.unit,
				...summarizeValues(metric.values)
			})),
			breakdowns: {
				routes: breakdown(routeValues, "route"),
				devices: breakdown(deviceValues, "deviceClass"),
				builds: breakdown(buildValues, "buildId")
			}
		};
	}

	public async exportCsv(instance: string, filters: FrontendPerformanceFilters) {
		const samples = await prismaService.frontendPerformanceSample.findMany({
			where: this.sampleWhere(instance, filters),
			include: { session: true },
			orderBy: { occurredAt: "asc" },
			take: 100_000
		});
		const header = [
			"sample_id", "occurred_at", "session_id", "user_id", "build_id", "device_class", "browser",
			"hardware_concurrency", "device_memory_gb", "effective_type", "viewport_width", "viewport_height",
			"route", "metric", "value", "unit", "tags"
		];
		const rows = samples.map((sample) => [
			sample.id.toString(), sample.occurredAt.toISOString(), sample.session.sessionId, sample.session.userId,
			sample.session.buildId, sample.session.deviceClass, sample.session.browser,
			sample.session.hardwareConcurrency, sample.session.deviceMemoryGb, sample.session.effectiveType,
			sample.session.viewportWidth, sample.session.viewportHeight, sample.route, sample.name, sample.value,
			sample.unit, sample.tags ? JSON.stringify(sample.tags) : ""
		]);
		return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
	}

	public async purgeExpired() {
		const cutoff = new Date(Date.now() - FRONTEND_PERFORMANCE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
		const deletedSamples = await prismaService.frontendPerformanceSample.deleteMany({
			where: { occurredAt: { lt: cutoff } }
		});
		const deletedSessions = await prismaService.frontendPerformanceSession.deleteMany({
			where: { samples: { none: {} }, lastSeenAt: { lt: cutoff } }
		});
		return { samples: deletedSamples.count, sessions: deletedSessions.count };
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
