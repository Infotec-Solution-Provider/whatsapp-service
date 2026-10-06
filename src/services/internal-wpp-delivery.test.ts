import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AxiosError, AxiosHeaders } from "axios";
import type { SessionData } from "../sdk-local";
import type { RemoteMessageJobResponse } from "../types/remote-client.types";
import type {
	InternalWhatsappQueueItem,
	InternalWhatsappQueuePayload
} from "./internal-whatsapp-message-queue.service";
import type { OpsAlertInput } from "./ops-alerts";

// In-memory world shared by the stubs below.
type MessageRow = {
	id: number; instance: string; from: string; internalChatId: number; body: string; status: string;
	wwebjsId: string | null; wwebjsIdStanza: string | null; clientId: number | null; fileId: null; fileName: null;
};
type QueueRow = {
	id: string; instance: string; internalChatId: number; internalMessageId: number; groupId: string; messageData: string;
	status: string; error: string | null; retryCount: number; createdAt: Date; processingStartedAt: Date | null;
	processedAt: Date | null; lockedUntil: Date | null; lockedBy: string | null;
};

const messages = new Map<number, MessageRow>();
const chats = new Map<number, { id: number; instance: string; wppGroupId: string | null }>();
const queue = new Map<string, QueueRow>();
const events: Array<{ type: string; data: Record<string, unknown> }> = [];
const alerts: OpsAlertInput[] = [];
const submitted: Array<{ key: string; text: string }> = [];
let syncEnabled = true;
let clientAvailable = true;
let reopenFailure: Error | null = null;
let beforeReopen: (() => void) | null = null;
let nextJob: () => RemoteMessageJobResponse | Promise<RemoteMessageJobResponse> = () => job("PENDING");

function job(status: RemoteMessageJobResponse["status"], extra: Partial<RemoteMessageJobResponse> = {}): RemoteMessageJobResponse {
	return {
		contractVersion: 1, jobId: "job-1", idempotencyKey: "k", status, result: null, error: null, attempts: 1,
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra
	};
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, expected]) => {
		if (expected && typeof expected === "object" && "in" in (expected as object)) {
			return ((expected as { in: unknown[] }).in).includes(row[key]);
		}
		return row[key] === expected;
	});
}

const prismaStub = {
	internalMessage: {
		findUnique: async ({ where, include }: { where: { id: number }; include?: { chat?: boolean } }) => {
			const row = messages.get(where.id);
			if (!row) return null;
			return include?.chat ? { ...row, chat: chats.get(row.internalChatId) ?? null } : { ...row };
		},
		update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
			const row = messages.get(where.id)!;
			const patch = { ...data };
			if (patch["client"]) {
				patch["clientId"] = (patch["client"] as { connect: { id: number } }).connect.id;
				delete patch["client"];
			}
			Object.assign(row, patch);
			return { ...row };
		},
		updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
			await Promise.resolve();
			const row = messages.get(where["id"] as number);
			if (!row || !matches(row, where)) return { count: 0 };
			Object.assign(row, data);
			return { count: 1 };
		}
	},
	internalChat: {
		findUnique: async ({ where }: { where: { id: number } }) => chats.get(where.id) ?? null
	},
	internalMessageProcessingQueue: {
		findFirst: async ({ where }: { where: { internalMessageId: number } }) =>
			[...queue.values()].find((row) => row.internalMessageId === where.internalMessageId) ?? null,
		update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
			Object.assign(queue.get(where.id)!, data);
			return { ...queue.get(where.id)! };
		}
	},
	wppSector: { findUnique: async () => ({ defaultClientId: 5 }) }
};

const client = {
	submitMessageJob: async (options: { text: string }, _isGroup: boolean, key: string) => {
		submitted.push({ key, text: options.text });
		return nextJob();
	},
	getMessageJob: async () => nextJob()
};

const previous = new Map<string, NodeModule | undefined>();
function stub(path: string, exports: unknown) {
	const resolved = require.resolve(path);
	previous.set(resolved, require.cache[resolved]);
	require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as NodeModule;
}
const stubDefault = (path: string, value: unknown) => stub(path, { __esModule: true, default: value });

let service: typeof import("./internal-chats.service").default;
let InternalWppRetryError: typeof import("./internal-chats.service").InternalWppRetryError;

before(() => {
	class SilentProcess { log() {} success() {} failed() {} }
	stubDefault("./prisma.service", prismaStub);
	stubDefault("./socket.service", {
		emit: async (type: string, _room: string, data: Record<string, unknown>) => { events.push({ type, data }); }
	});
	stubDefault("./parameters.service", { isInternalGroupWhatsappSyncEnabled: async () => syncEnabled });
	stub("./whatsapp.service", {
		__esModule: true, default: { getClient: () => (clientAvailable ? client : undefined) }, getMessageType: () => "chat"
	});
	stubDefault("./internal-whatsapp-message-queue.service", {
		enqueue: async () => "queue-1",
		reopenForManualRetry: async (id: string, expectedMessageData: string, messageData: string) => {
			await Promise.resolve();
			beforeReopen?.();
			if (reopenFailure) throw reopenFailure;
			const row = queue.get(id);
			if (!row || !["FAILED", "UNKNOWN"].includes(row.status) || row.messageData !== expectedMessageData) return false;
			Object.assign(row, {
				status: "PENDING", error: null, lockedBy: null, lockedUntil: null, processedAt: null,
				processingStartedAt: null, retryCount: 0, messageData
			});
			return true;
		}
	});
	stubDefault("./ops-alerts", { emit: (alert: OpsAlertInput) => { alerts.push(alert); } });
	stubDefault("./message-presentation.service", { hydrate: async (_instance: string, rows: unknown[]) => rows });
	stubDefault("../utils/processing-logger", SilentProcess);
	stub("../utils/file-upload-trace", { createUploadTraceLogger: () => ({ info() {}, error() {} }) });
	for (const path of ["./files.service", "./users.service", "./internal-whatsapp-senders.service", "../utils/whatsapp-audio-converter"]) {
		stubDefault(path, {});
	}
	const servicePath = require.resolve("./internal-chats.service");
	previous.set(servicePath, require.cache[servicePath]);
	delete require.cache[servicePath];
	const loaded = require("./internal-chats.service") as typeof import("./internal-chats.service");
	service = loaded.default;
	InternalWppRetryError = loaded.InternalWppRetryError;
});

after(() => {
	for (const [path, cached] of previous) {
		if (cached) require.cache[path] = cached;
		else delete require.cache[path];
	}
});

const session = { instance: "acme", userId: 12, sectorId: 3, name: "Ana", role: "OPERATOR" } as SessionData;

function basePayload(extra: Partial<InternalWhatsappQueuePayload> = {}): InternalWhatsappQueuePayload {
	return {
		clientId: 5,
		session: { userId: 12, sectorId: 3, role: "OPERATOR", instance: "acme", name: "Ana" },
		data: {},
		...extra
	};
}

beforeEach(() => {
	messages.clear(); chats.clear(); queue.clear();
	events.length = 0; alerts.length = 0; submitted.length = 0;
	syncEnabled = true;
	clientAvailable = true;
	reopenFailure = null;
	beforeReopen = null;
	chats.set(8, { id: 8, instance: "acme", wppGroupId: "group@g.us" });
	messages.set(42, {
		id: 42, instance: "acme", from: "user:12", internalChatId: 8, body: "Olá", status: "PENDING",
		wwebjsId: null, wwebjsIdStanza: null, clientId: null, fileId: null, fileName: null
	});
	queue.set("queue-1", {
		id: "queue-1", instance: "acme", internalChatId: 8, internalMessageId: 42, groupId: "group@g.us",
		messageData: JSON.stringify(basePayload({ remoteJobId: "job-1" })), status: "PROCESSING", error: null, retryCount: 0,
		createdAt: new Date(Date.now() - 2_000), processingStartedAt: new Date(Date.now() - 1_000), processedAt: null,
		lockedUntil: null, lockedBy: null
	});
});

function item(): InternalWhatsappQueueItem {
	return { ...queue.get("queue-1")! } as unknown as InternalWhatsappQueueItem;
}

function lastStatusEvent() {
	return events.filter((event) => event.type === "internal_message_status").at(-1)?.data;
}

function axiosError(status: number): AxiosError {
	const headers = new AxiosHeaders();
	return new AxiosError("HTTP " + status, "ERR_BAD_REQUEST", { headers }, {}, {
		status, statusText: "x", headers, config: { headers }, data: {}
	});
}

// ─── S3: outcome mapping matrix ─────────────────────────────────────────────

const future = () => new Date(Date.now() + 60_000).toISOString();
const longPast = () => new Date(Date.now() - 10 * 60_000).toISOString();

const matrix: Array<{
	name: string;
	job: () => RemoteMessageJobResponse | Error;
	queueStatus: string;
	message: string;
	kind?: string;
	safe?: boolean;
	hint?: Record<string, unknown>;
}> = [
	{ name: "PENDING keeps polling", job: () => job("PENDING"), queueStatus: "PENDING", message: "PENDING" },
	{ name: "PROCESSING keeps polling", job: () => job("PROCESSING"), queueStatus: "PENDING", message: "PENDING" },
	{
		name: "UNKNOWN while VERIFYING waits for the receipt window",
		job: () => job("UNKNOWN", { confirmationStatus: "VERIFYING", confirmationDeadlineAt: future() }),
		queueStatus: "PENDING", message: "PENDING"
	},
	{
		name: "UNKNOWN VERIFYING far past its deadline is not trusted",
		job: () => job("UNKNOWN", { confirmationStatus: "VERIFYING", confirmationDeadlineAt: longPast() }),
		queueStatus: "UNKNOWN", message: "ERROR", kind: "UNKNOWN", safe: false,
		hint: { allowed: true, requiresConfirmation: true }
	},
	{
		name: "UNKNOWN TIMED_OUT is ambiguous",
		job: () => job("UNKNOWN", { confirmationStatus: "TIMED_OUT" }),
		queueStatus: "UNKNOWN", message: "ERROR", kind: "UNKNOWN", safe: false,
		hint: { allowed: true, requiresConfirmation: true }
	},
	{
		name: "UNKNOWN without confirmation status is ambiguous",
		job: () => job("UNKNOWN"), queueStatus: "UNKNOWN", message: "ERROR", kind: "UNKNOWN", safe: false
	},
	{
		name: "SENT without result is treated as UNKNOWN",
		job: () => job("SENT"), queueStatus: "UNKNOWN", message: "ERROR", kind: "UNKNOWN", safe: false
	},
	{
		name: "FAILED NOT_SENT is safe to resend",
		job: () => job("FAILED", { failureKind: "NOT_SENT", error: "Connection Closed" }),
		queueStatus: "FAILED", message: "ERROR", kind: "NOT_SENT", safe: true,
		hint: { allowed: true, requiresConfirmation: false }
	},
	{
		name: "FAILED ERROR is not provably unsent",
		job: () => job("FAILED", { failureKind: "ERROR", error: "boom" }),
		queueStatus: "FAILED", message: "ERROR", kind: "FAILED", safe: false,
		hint: { allowed: true, requiresConfirmation: true }
	},
	{
		name: "legacy FAILED without failureKind requires confirmation",
		job: () => job("FAILED", { error: "boom" }), queueStatus: "FAILED", message: "ERROR", kind: "FAILED", safe: false
	},
	{
		name: "a vanished remote job (404) is UNKNOWN",
		job: () => axiosError(404), queueStatus: "UNKNOWN", message: "ERROR", kind: "UNKNOWN", safe: false
	},
	{
		name: "a rejected request (409) is FAILED but not provably unsent",
		job: () => axiosError(409), queueStatus: "FAILED", message: "ERROR", kind: "FAILED", safe: false
	}
];

for (const scenario of matrix) {
	test(`S3 ${scenario.name}`, async () => {
		nextJob = () => {
			const value = scenario.job();
			if (value instanceof Error) throw value;
			return value;
		};
		const result = await service.processQueuedWppGroupMessage(item());
		assert.equal(result.status, scenario.queueStatus === "PENDING" ? "PENDING" : scenario.queueStatus);
		assert.equal(messages.get(42)!.status, scenario.message);
		if (scenario.queueStatus === "PENDING") {
			assert.equal(result.messageData, undefined, "no payload write on a plain poll");
			assert.equal(alerts.length, 0);
			return;
		}
		const payload = JSON.parse(result.messageData!) as InternalWhatsappQueuePayload;
		assert.equal(payload.outcome?.kind, scenario.kind);
		assert.equal(payload.outcome?.safeToResend, scenario.safe);
		assert.ok(payload.timing?.completedAt);
		assert.ok(result.error?.startsWith(`[${scenario.kind}] `), result.error);
		const event = lastStatusEvent()!;
		assert.equal(event["status"], "ERROR");
		assert.deepEqual(
			event["whatsappRetry"],
			scenario.hint ?? (scenario.safe ? { allowed: true, requiresConfirmation: false } : { allowed: true, requiresConfirmation: true })
		);
		assert.equal(alerts.length, 1);
		assert.equal(alerts[0]!.type, "SEND_FAILED");
		assert.equal(alerts[0]!.refs?.internalMessageId, 42);
		assert.equal(alerts[0]!.refs?.outcome, scenario.kind);
		assert.ok(!JSON.stringify(alerts[0]).includes("Olá"), "alert carries no message body");
	});
}

test("S3 a transport error is rethrown for an idempotent queue retry", async () => {
	nextJob = () => { throw axiosError(500); };
	await assert.rejects(service.processQueuedWppGroupMessage(item()));
	assert.equal(messages.get(42)!.status, "PENDING");
});

test("S3 SENT with result completes, persists ids and records timing", async () => {
	nextJob = () => job("SENT", {
		result: { wwebjsId: "wa-1", wwebjsIdStanza: "st-1" } as RemoteMessageJobResponse["result"],
		sendSessionId: "acme_zapo", sendLibrary: "ZAPO", fallback: false, sendDurationMs: 900
	});
	const result = await service.processQueuedWppGroupMessage(item());
	assert.equal(result.status, "COMPLETED");
	assert.equal(messages.get(42)!.status, "RECEIVED");
	assert.equal(messages.get(42)!.wwebjsId, "wa-1");
	const payload = JSON.parse(result.messageData!) as InternalWhatsappQueuePayload;
	assert.ok(payload.timing?.completedAt);
	assert.equal(lastStatusEvent()!["whatsappRetry"], undefined);
	assert.equal(alerts.length, 0, "fast success raises no alert");
});

test("S3 submit uses the generation-aware key and records firstClaimAt/submittedAt", async () => {
	const row = queue.get("queue-1")!;
	for (const [generation, key] of [[0, "acme:internal-message:42"], [2, "acme:internal-message:42:retry:2"]] as const) {
		submitted.length = 0;
		row.messageData = JSON.stringify(basePayload({ retryGeneration: generation }));
		nextJob = () => job("PENDING", { jobId: `job-g${generation}` });
		const claimedAt = row.processingStartedAt!.toISOString();
		await service.processQueuedWppGroupMessage(item());
		assert.equal(submitted[0]!.key, key);
		assert.equal(submitted[0]!.text, "*Ana*: Olá", "the original author's name is kept");
		const stored = JSON.parse(row.messageData) as InternalWhatsappQueuePayload;
		assert.equal(stored.remoteJobId, `job-g${generation}`);
		assert.equal(stored.timing?.firstClaimAt, claimedAt);
		assert.ok(stored.timing?.submittedAt);
	}
});

test("S3 slow in-flight send is logged and alerted once, persisting slowAlertedAt", async () => {
	const row = queue.get("queue-1")!;
	row.createdAt = new Date(Date.now() - 30_000);
	nextJob = () => job("PROCESSING", { sendSessionId: "acme", sendLibrary: "BAILEYS" });
	const first = await service.processQueuedWppGroupMessage(item());
	assert.equal(first.status, "PENDING");
	const payload = JSON.parse(first.messageData!) as InternalWhatsappQueuePayload;
	assert.ok(payload.timing?.slowAlertedAt);
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0]!.type, "SEND_SLOW");
	assert.equal(alerts[0]!.sessionId, "acme");
	assert.ok((alerts[0]!.refs?.durationMs ?? 0) >= 30_000);

	row.messageData = first.messageData!;
	const second = await service.processQueuedWppGroupMessage(item());
	assert.deepEqual(second, { status: "PENDING" });
	assert.equal(alerts.length, 1, "slow alert is not repeated on later polls");
});

test("S3 a send that turns slow between polls still logs one `slow` line at its terminal poll", async () => {
	const { Logger } = require("@in.pulse-crm/utils") as typeof import("@in.pulse-crm/utils");
	const lines: string[] = [];
	const original = Logger.info;
	Logger.info = ((message: string) => { lines.push(String(message)); }) as typeof Logger.info;
	try {
		for (const terminal of [
			() => job("SENT", { result: { wwebjsId: "wa-1", wwebjsIdStanza: "st-1" } as RemoteMessageJobResponse["result"] }),
			() => job("FAILED", { failureKind: "NOT_SENT" })
		]) {
			lines.length = 0;
			alerts.length = 0;
			messages.get(42)!.status = "PENDING";
			messages.get(42)!.wwebjsId = null;
			const row = queue.get("queue-1")!;
			row.createdAt = new Date(Date.now() - 30_000);
			row.messageData = JSON.stringify(basePayload({ remoteJobId: "job-1" }));
			nextJob = terminal;
			const result = await service.processQueuedWppGroupMessage(item());
			const slowLines = lines.filter((line) => line.startsWith("[internal-wpp-send] slow "));
			assert.equal(slowLines.length, 1, result.status);
			assert.ok(!slowLines[0]!.includes("Olá"), "no message body in logs");
			assert.ok((JSON.parse(result.messageData!) as InternalWhatsappQueuePayload).timing?.slowAlertedAt);
			assert.deepEqual(alerts.map((alert) => alert.type), [result.status === "COMPLETED" ? "SEND_SLOW" : "SEND_FAILED"]);
		}
	} finally {
		Logger.info = original;
	}
});

test("S3 slow measurement restarts at a manual resend", async () => {
	const row = queue.get("queue-1")!;
	row.createdAt = new Date(Date.now() - 600_000);
	row.messageData = JSON.stringify(basePayload({ remoteJobId: "job-1", retryGeneration: 1, lastRetryAt: new Date(Date.now() - 2_000).toISOString() }));
	nextJob = () => job("PROCESSING");
	assert.deepEqual(await service.processQueuedWppGroupMessage(item()), { status: "PENDING" });
	assert.equal(alerts.length, 0);
});

// ─── S4: retry hint on the status event ─────────────────────────────────────

test("S4 hint reports RETRY_LIMIT after three manual resends", async () => {
	queue.get("queue-1")!.messageData = JSON.stringify(basePayload({ remoteJobId: "job-1", retryGeneration: 3 }));
	nextJob = () => job("FAILED", { failureKind: "NOT_SENT" });
	await service.processQueuedWppGroupMessage(item());
	assert.deepEqual(lastStatusEvent()!["whatsappRetry"], { allowed: false, requiresConfirmation: false, reason: "RETRY_LIMIT" });
});

// ─── S5: manual retry rules ─────────────────────────────────────────────────

function failedState(outcome: InternalWhatsappQueuePayload["outcome"] | null, extra: Partial<InternalWhatsappQueuePayload> = {}) {
	const row = queue.get("queue-1")!;
	row.status = outcome?.kind === "UNKNOWN" ? "UNKNOWN" : "FAILED";
	row.processedAt = new Date();
	row.processingStartedAt = new Date(Date.now() - 5_000);
	row.retryCount = 2;
	row.error = "[X] y";
	row.messageData = JSON.stringify(basePayload({
		remoteJobId: "job-1", timing: { firstClaimAt: new Date().toISOString() }, ...(outcome ? { outcome } : {}), ...extra
	}));
	messages.get(42)!.status = "ERROR";
}
const notSent = () => ({ kind: "NOT_SENT" as const, safeToResend: true, at: new Date().toISOString() });
const unknown = () => ({ kind: "UNKNOWN" as const, safeToResend: false, at: new Date().toISOString() });

async function retryCode(actor: SessionData, confirmUncertain?: boolean): Promise<string> {
	try {
		await service.retryWppGroupMessage(actor, 42, confirmUncertain === undefined ? {} : { confirmUncertain });
		return "OK";
	} catch (error) {
		assert.ok(error instanceof InternalWppRetryError, String(error));
		return `${error.statusCode}:${error.code}`;
	}
}

test("S5 provably-unsent message is reopened directly by its author", async () => {
	failedState(notSent());
	const result = await service.retryWppGroupMessage(session, 42);
	assert.deepEqual(result, { id: 42, status: "PENDING" });
	assert.equal(messages.get(42)!.status, "PENDING");
	const row = queue.get("queue-1")!;
	assert.equal(row.status, "PENDING");
	assert.equal(row.error, null);
	assert.equal(row.retryCount, 0);
	assert.equal(row.processedAt, null);
	assert.equal(row.processingStartedAt, null);
	const payload = JSON.parse(row.messageData) as InternalWhatsappQueuePayload;
	assert.equal(payload.remoteJobId, undefined);
	assert.equal(payload.outcome, undefined);
	assert.deepEqual(payload.timing, {});
	assert.equal(payload.retryGeneration, 1);
	assert.equal(payload.lastRetryBy, 12);
	assert.equal(payload.session.name, "Ana");
	assert.equal(lastStatusEvent()!["status"], "PENDING");

	// The next queue pass submits a NEW remote job for generation 1.
	nextJob = () => job("PENDING", { jobId: "job-2" });
	await service.processQueuedWppGroupMessage(item());
	assert.equal(submitted.at(-1)!.key, "acme:internal-message:42:retry:1");
});

test("S5 ambiguous outcomes need explicit confirmation", async () => {
	failedState(unknown());
	assert.equal(await retryCode(session), "409:CONFIRMATION_REQUIRED");
	assert.equal(await retryCode(session, false), "409:CONFIRMATION_REQUIRED");
	assert.equal(messages.get(42)!.status, "ERROR", "nothing changes without confirmation");
	assert.equal(await retryCode(session, true), "OK");

	failedState(null);
	assert.equal(await retryCode(session), "409:CONFIRMATION_REQUIRED", "legacy rows without outcome are ambiguous");
});

test("S5 only the author or an ADMIN may resend", async () => {
	failedState(notSent());
	const other = { ...session, userId: 99 } as SessionData;
	assert.equal(await retryCode(other), "403:FORBIDDEN");
	assert.equal(await retryCode({ ...other, role: "ADMIN" } as SessionData), "OK");
});

test("S5 message outside the session instance is not found", async () => {
	failedState(notSent());
	assert.equal(await retryCode({ ...session, instance: "other" } as SessionData), "404:NOT_FOUND");
	messages.delete(42);
	assert.equal(await retryCode(session), "404:NOT_FOUND");
});

test("S5 non-retryable states", async () => {
	const template = { ...queue.get("queue-1")! };
	const cases: Array<[string, () => void]> = [
		["chat not linked", () => { chats.get(8)!.wppGroupId = null; }],
		["sync disabled", () => { syncEnabled = false; }],
		["status not ERROR", () => { messages.get(42)!.status = "RECEIVED"; }],
		["already has a WhatsApp id", () => { messages.get(42)!.wwebjsId = "wa-1"; }],
		["no queue row", () => { queue.clear(); }],
		["queue row still in flight", () => { queue.get("queue-1")!.status = "PENDING"; }],
		["chat re-linked to another group", () => { chats.get(8)!.wppGroupId = "other@g.us"; }],
		["original client unavailable", () => { clientAvailable = false; }]
	];
	for (const [name, mutate] of cases) {
		chats.get(8)!.wppGroupId = "group@g.us";
		syncEnabled = true;
		clientAvailable = true;
		messages.get(42)!.wwebjsId = null;
		queue.set("queue-1", { ...template });
		failedState(notSent());
		assert.ok(queue.get("queue-1")!.internalMessageId === 42);
		mutate();
		assert.equal(await retryCode(session), "409:NOT_RETRYABLE", name);
		assert.equal(messages.get(42)!.status === "PENDING", false, `${name}: no claim`);
	}
});

test("S5 retry limits: three generations and a 10 s cooldown", async () => {
	failedState(notSent(), { retryGeneration: 3 });
	assert.equal(await retryCode(session), "409:RETRY_LIMIT");
	failedState(notSent(), { retryGeneration: 1, lastRetryAt: new Date(Date.now() - 5_000).toISOString() });
	assert.equal(await retryCode(session), "409:RETRY_LIMIT");
	failedState(notSent(), { retryGeneration: 1, lastRetryAt: new Date(Date.now() - 11_000).toISOString() });
	assert.equal(await retryCode(session), "OK");
	assert.equal((JSON.parse(queue.get("queue-1")!.messageData) as InternalWhatsappQueuePayload).retryGeneration, 2);
});

test("S5 concurrent resends: exactly one wins the atomic claim", async () => {
	failedState(notSent());
	const results = await Promise.all([retryCode(session), retryCode(session)]);
	assert.deepEqual(results.sort(), ["409:NOT_RETRYABLE", "OK"]);
	assert.equal((JSON.parse(queue.get("queue-1")!.messageData) as InternalWhatsappQueuePayload).retryGeneration, 1);
});

test("S5 a failing reopen releases the claim so the message stays retryable", async () => {
	failedState(notSent());
	reopenFailure = new Error("db down");
	await assert.rejects(service.retryWppGroupMessage(session, 42), /db down/);
	assert.equal(messages.get(42)!.status, "ERROR");
	assert.equal(queue.get("queue-1")!.status, "FAILED");
	reopenFailure = null;
	assert.equal(await retryCode(session), "OK");
});

test("S5 a stale queue snapshot never reopens (decisions are re-validated by the reopen)", async () => {
	failedState(notSent());
	// Another resend finished between this request's read and its reopen: payload changed.
	beforeReopen = () => {
		const row = queue.get("queue-1")!;
		row.messageData = JSON.stringify(basePayload({ retryGeneration: 1, outcome: unknown() }));
		beforeReopen = null;
	};
	assert.equal(await retryCode(session), "409:NOT_RETRYABLE");
	assert.equal(messages.get(42)!.status, "ERROR", "claim released");
	assert.equal(queue.get("queue-1")!.status, "FAILED");
	assert.equal(await retryCode(session), "409:CONFIRMATION_REQUIRED", "the fresh outcome is the one that counts");
});

test("S5 the endpoint never overwrites a terminal status the worker wrote after the reopen", async () => {
	failedState(notSent());
	// The worker claims the reopened row and fails at once, before the endpoint notifies.
	const original = prismaStub.internalMessage.findUnique;
	prismaStub.internalMessage.findUnique = async (args) => {
		const result = await original(args);
		if (!args.include && queue.get("queue-1")!.status === "PENDING") {
			messages.get(42)!.status = "ERROR";
			return { ...messages.get(42)! };
		}
		return result;
	};
	try {
		assert.deepEqual(await service.retryWppGroupMessage(session, 42), { id: 42, status: "PENDING" });
	} finally {
		prismaStub.internalMessage.findUnique = original;
	}
	assert.equal(messages.get(42)!.status, "ERROR");
	assert.equal(lastStatusEvent()!["status"], "ERROR", "publishes the persisted status");
});
