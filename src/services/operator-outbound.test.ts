import assert from "node:assert/strict";
import { Prisma, PrismaClient } from "@prisma/client";
import PrismaOperatorOutboundRepository from "./operator-outbound.repository";
import { OperatorOutboundService } from "./operator-outbound.service";
import {
	OperatorOutboundEnqueueInput,
	OperatorOutboundHandler,
	OperatorOutboundRequestError,
} from "./operator-outbound.types";

// This adapter exercises the REAL repository/worker with isolated transactions,
// uniqueness, rollback and controlled failures. It never connects to a database.
// It does not substitute for validating MySQL migrations and locking in a pilot.
type Row = Record<string, any>;
type State = { messages: Row[]; jobs: Row[]; nextMessageId: number };

function matches(row: Row, where: Row = {}): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (key === "OR") return (condition as Row[]).some((branch) => matches(row, branch));
		if (key === "instance_userId_idempotencyKey") {
			assert.deepEqual(Object.keys(condition).sort(), ["idempotencyKey", "instance", "userId"]);
			return matches(row, condition);
		}
		const actual = row[key];
		if (condition && typeof condition === "object" && !(condition instanceof Date)) {
			return Object.entries(condition).every(([operator, expected]: [string, any]) => {
				switch (operator) {
					case "lte": return actual !== null && actual <= expected;
					case "gt": return actual !== null && actual > expected;
					case "in": return expected.includes(actual);
					case "notIn": return !expected.includes(actual);
					default: throw new Error(`Unsupported mock predicate ${operator}`);
				}
			});
		}
		return actual === condition;
	});
}

function applyData(row: Row, data: Row): void {
	for (const [key, value] of Object.entries(data)) {
		row[key] = value && typeof value === "object" && "increment" in value ? row[key] + value.increment : structuredClone(value);
	}
}

class IsolatedDatabase {
	state: State = { messages: [], jobs: [], nextMessageId: 1 };
	failReceipt = false;
	beforeExpiredReadReturns: (() => Promise<void>) | null = null;
	private tail = Promise.resolve();
	constructor(readonly now: () => Date) {}

	private async locked<T>(operation: () => Promise<T> | T): Promise<T> {
		let release!: () => void;
		const previous = this.tail;
		this.tail = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try { return await operation(); }
		finally { release(); }
	}

	client(): PrismaClient { return this.api() as unknown as PrismaClient; }

	private api(transactionState?: State): Row {
		const execute = async <T>(operation: (state: State) => T): Promise<T> => {
			if (transactionState) return operation(transactionState);
			return this.locked(() => operation(this.state));
		};
		const delegate = (table: "messages" | "jobs"): Row => {
			const read = (state: State, row: Row | undefined, args: Row): any => {
				if (!row) return null;
				const result = structuredClone(row);
				if (args["include"]?.message) result["message"] = structuredClone(state.messages.find((message) => message["id"] === row["messageId"]));
				return result;
			};
			return {
				findUnique: (args: Row) => execute((state) => read(state, state[table].find((row) => matches(row, args["where"])), args)),
				findUniqueOrThrow: (args: Row) => execute((state) => {
					const row = state[table].find((entry) => matches(entry, args["where"]));
					assert.ok(row, "Expected persisted row");
					return read(state, row, args);
				}),
				findMany: async (args: Row) => {
					const result = await execute((state) => state[table].filter((row) => matches(row, args["where"]))
						.slice(0, args["take"] ?? 100).map((row) => read(state, row, args)));
					if (table === "jobs" && args["where"]?.status === "PROCESSING" && this.beforeExpiredReadReturns) {
						const hook = this.beforeExpiredReadReturns;
						this.beforeExpiredReadReturns = null;
						await hook();
					}
					return result;
				},
				create: (args: Row) => execute((state) => {
					const data = structuredClone(args["data"]);
					if (table === "jobs" && state.jobs.some((job) => job["instance"] === data.instance && job["userId"] === data.userId && job["idempotencyKey"] === data.idempotencyKey)) {
						throw new Prisma.PrismaClientKnownRequestError("Duplicate scope/key", { code: "P2002", clientVersion: "test" });
					}
					const row = table === "messages" ? {
						id: state.nextMessageId++, wwebjsId: null, wwebjsIdStanza: null, wabaId: null,
						gupshupId: null, gupshupRequestId: null, isForwarded: false, isEdited: false,
						quotedId: null, chatId: null, contactId: null, statusTimestamp: null, fileId: null,
						fileName: null, fileType: null, fileSize: null, agentId: null, billingCategory: null, ...data,
					} : {
						id: `job-${state.jobs.length + 1}`, status: "PENDING", remoteJobId: null, providerOutcome: null,
						attemptStartedAt: null, attemptCount: 0, nextAttemptAt: this.now(), lockedBy: null,
						lockedUntil: null, error: null, createdAt: this.now(), updatedAt: this.now(),
						completedAt: null, notificationPending: false, ...data,
					};
					state[table].push(row);
					return structuredClone(row);
				}),
				updateMany: (args: Row) => execute((state) => {
					if (this.failReceipt && args["data"]?.providerOutcome) throw new Error("Database unavailable after provider accepted");
					const rows = state[table].filter((row) => matches(row, args["where"]));
					rows.forEach((row) => applyData(row, args["data"]));
					return { count: rows.length };
				}),
				update: (args: Row) => execute((state) => {
					const row = state[table].find((entry) => matches(entry, args["where"]));
					assert.ok(row);
					applyData(row, args["data"]);
					return read(state, row, args);
				}),
			};
		};
		return {
			wppMessage: delegate("messages"), operatorOutboundSend: delegate("jobs"),
			$transaction: async (callback: (tx: Row) => Promise<unknown>) => this.locked(async () => {
				const snapshot = structuredClone(this.state);
				const result = await callback(this.api(snapshot));
				this.state = snapshot;
				return result;
			}),
		};
	}
}

function input(overrides: Partial<OperatorOutboundEnqueueInput> = {}): OperatorOutboundEnqueueInput {
	return {
		instance: "tenant-a", userId: 7, clientId: 9, idempotencyKey: "attempt-1", payloadHash: "a".repeat(64),
		deliveryMode: "DIRECT", payload: { options: { text: "hello" } },
		message: { instance: "tenant-a", from: "551100000000", to: "551199999999", type: "chat", body: "hello", timestamp: "1788868800", sentAt: new Date(), status: "PENDING" },
		...overrides,
	};
}

function fixture(handler: Partial<OperatorOutboundHandler> = {}) {
	let clock = Date.now() + 1_000;
	let sends = 0;
	let notifications = 0;
	const errors: unknown[] = [];
	const db = new IsolatedDatabase(() => new Date(clock));
	const repository = new PrismaOperatorOutboundRepository(db.client());
	const options = { now: () => new Date(clock), lockMs: 1_000, retryMs: 100, onError: (error: unknown) => errors.push(error) };
	const configured: OperatorOutboundHandler = {
		deliver: async () => { sends++; return { status: "SENT", result: { wwebjsId: "provider-message-1" } }; },
		onMessage: async () => { notifications++; },
		...handler,
	};
	const worker = () => { const service = new OperatorOutboundService(repository, options); service.setHandler(configured); return service; };
	return {
		db, repository, service: worker(), worker, configured, errors,
		advance: (milliseconds = 1_001) => { clock += milliseconds; },
		now: () => new Date(clock), sends: () => sends, notifications: () => notifications,
		job: () => db.state.jobs[0]!, message: () => db.state.messages[0]!,
	};
}

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, body: () => Promise<void>) => tests.push([name, body]);

test("concurrent duplicate requests commit one message/job and replay a lost HTTP response", async () => {
	const f = fixture();
	const [first, second] = await Promise.all([f.service.enqueue(input()), f.service.enqueue(input())]);
	assert.equal(first.message.id, second.message.id);
	assert.equal(Number(first.created) + Number(second.created), 1);
	assert.equal(f.db.state.messages.length, 1);
	assert.equal(f.db.state.jobs.length, 1);
	const replay = await f.service.enqueue(input());
	assert.equal(replay.created, false);
	assert.equal(replay.message.id, first.message.id);
	assert.equal(f.sends(), 0, "enqueue must only persist");
	await Promise.all([f.service.processOnce(), f.worker().processOnce()]);
	assert.equal(f.sends(), 1);
	assert.equal(f.message()["status"], "SENT");
});

test("same key conflicts on content/channel and remains isolated by authenticated scope", async () => {
	const f = fixture();
	await f.service.enqueue(input());
	for (const override of [{ payloadHash: "b".repeat(64) }, { clientId: 10 }, { deliveryMode: "REMOTE" as const }]) {
		await assert.rejects(f.service.enqueue(input(override)), (error: unknown) => error instanceof OperatorOutboundRequestError && error.statusCode === 409);
	}
	assert.equal(await f.service.lookup({ instance: "tenant-b", userId: 7 }, "attempt-1"), null);
	assert.equal(await f.service.lookup({ instance: "tenant-a", userId: 8 }, "attempt-1"), null);
	assert.equal(f.db.state.messages.length, 1);
});

test("startup unavailability defers DIRECT before recording intent", async () => {
	let ready = false;
	const f = fixture({ preflight: async () => ready });
	await f.service.enqueue(input());
	await f.service.processOnce();
	assert.equal(f.job()["status"], "PENDING");
	assert.equal(f.job()["attemptStartedAt"], null);
	assert.equal(f.sends(), 0);
	ready = true;
	f.advance();
	await f.service.processOnce();
	assert.equal(f.sends(), 1);
});

test("restart before provider intent reclaims and sends once", async () => {
	const f = fixture();
	const { job } = await f.service.enqueue(input());
	await f.repository.claim(job.id, "crashed-before-intent", f.now(), new Date(f.now().getTime() + 1_000));
	f.advance();
	await f.worker().processOnce();
	assert.equal(f.sends(), 1);
	assert.equal(f.message()["status"], "SENT");
});

test("restart after DIRECT intent produces UNKNOWN without invoking provider again", async () => {
	const f = fixture();
	const { job } = await f.service.enqueue(input());
	await f.repository.claim(job.id, "crashed-after-intent", f.now(), new Date(f.now().getTime() + 1_000));
	await f.repository.markAttemptStarted(job.id, "crashed-after-intent", f.now());
	f.advance();
	await f.worker().processOnce();
	assert.equal(f.sends(), 0);
	assert.equal(f.job()["status"], "UNKNOWN");
	assert.equal(f.message()["status"], "UNKNOWN");
	assert.equal((await f.service.enqueue(input())).message.status, "UNKNOWN");
	await f.worker().processOnce();
	assert.equal(f.sends(), 0);
});

test("ambiguous provider failure is UNKNOWN; explicit rejection is ERROR", async () => {
	const unknown = fixture({ deliver: async () => { throw new Error("response lost after dispatch"); } });
	await unknown.service.enqueue(input());
	await unknown.service.processOnce();
	assert.equal(unknown.message()["status"], "UNKNOWN");
	const rejected = fixture({ deliver: async () => ({ status: "FAILED", error: "invalid recipient before dispatch" }) });
	await rejected.service.enqueue(input());
	await rejected.service.processOnce();
	assert.equal(rejected.message()["status"], "ERROR");
});

test("database failure after provider acceptance cannot cause a second DIRECT send", async () => {
	const f = fixture();
	await f.service.enqueue(input());
	f.db.failReceipt = true;
	await f.service.processOnce();
	assert.equal(f.sends(), 1);
	assert.equal(f.job()["status"], "PROCESSING");
	f.db.failReceipt = false;
	f.advance();
	await f.worker().processOnce();
	assert.equal(f.sends(), 1);
	assert.equal(f.message()["status"], "UNKNOWN");
});

test("durable provider receipt retries only transactional local finalization", async () => {
	let finalizeCalls = 0;
	const f = fixture({ finalize: async () => { if (++finalizeCalls === 1) throw new Error("pipeline database effect failed"); } });
	await f.service.enqueue(input());
	await f.service.processOnce();
	assert.equal(f.sends(), 1);
	assert.equal(f.message()["status"], "PENDING", "message and local effects must rollback together");
	assert.equal(f.job()["providerOutcome"].status, "SENT");
	f.advance();
	await f.worker().processOnce();
	assert.equal(f.sends(), 1);
	assert.equal(finalizeCalls, 2);
	assert.equal(f.message()["status"], "SENT");
	assert.equal(f.message()["wwebjsId"], "provider-message-1");
});

test("recovery re-reads a receipt saved after expired-candidate snapshot", async () => {
	const f = fixture();
	const { job } = await f.service.enqueue(input());
	await f.repository.claim(job.id, "slow-worker", f.now(), new Date(f.now().getTime() + 1_000));
	await f.repository.markAttemptStarted(job.id, "slow-worker", f.now());
	f.advance();
	f.db.beforeExpiredReadReturns = async () => { await f.repository.recordOutcome(job.id, "slow-worker", { status: "SENT", result: { wwebjsId: "late-confirmation" } }); };
	await f.worker().processOnce();
	assert.equal(f.sends(), 0);
	assert.equal(f.message()["status"], "SENT");
	assert.equal(f.message()["wwebjsId"], "late-confirmation");
});

test("stale lease tokens cannot dispatch or overwrite newer ownership", async () => {
	const f = fixture();
	const { job } = await f.service.enqueue(input());
	await f.repository.claim(job.id, "old", f.now(), new Date(f.now().getTime() + 1_000));
	f.advance();
	await f.repository.recoverExpired(f.now());
	await f.repository.claim(job.id, "new", f.now(), new Date(f.now().getTime() + 1_000));
	assert.equal(await f.repository.markAttemptStarted(job.id, "old", f.now()), false);
	assert.equal(await f.repository.recordOutcome(job.id, "old", { status: "SENT" }), false);
	assert.equal(f.job()["lockedBy"], "new");
});

test("notification failures retry local effects without resending or regressing receipt", async () => {
	let notifications = 0;
	const f = fixture({ onMessage: async () => { if (++notifications === 1) throw new Error("socket/local sync offline"); } });
	await f.service.enqueue(input());
	await f.service.processOnce();
	assert.equal(f.sends(), 1);
	assert.equal(f.job()["status"], "SENT");
	assert.equal(f.job()["notificationPending"], true);
	f.advance();
	await f.worker().processOnce();
	assert.equal(f.sends(), 1);
	assert.equal(notifications, 2);
	assert.equal(f.job()["notificationPending"], false);
});

test("delivery/read/download statuses never regress; provider cannot replace draft scope", async () => {
	for (const status of ["SENT", "RECEIVED", "READ", "DOWNLOADED"] as const) {
		const f = fixture({ deliver: async () => ({ status: "UNKNOWN", result: { instance: "attacker", userId: 90, body: "replacement", wwebjsId: "trusted-id" } }) });
		await f.service.enqueue(input());
		f.message()["status"] = status;
		await f.service.processOnce();
		assert.equal(f.message()["status"], status);
		assert.equal(f.message()["instance"], "tenant-a");
		assert.equal(f.message()["userId"], 7);
		assert.equal(f.message()["body"], "hello");
		assert.equal(f.message()["wwebjsId"], "trusted-id");
		assert.equal(f.job()["status"], "SENT");
	}
});

test("REMOTE lost submission response retries the same operation and then polls its saved job", async () => {
	const submitted: string[] = [];
	const remoteIds: Array<string | null> = [];
	let calls = 0;
	const f = fixture({ deliver: async (item) => {
		submitted.push(item.id);
		remoteIds.push(item.remoteJobId);
		if (++calls === 1) throw new Error("HTTP response lost after remote accepted");
		if (calls === 2) return { status: "PENDING", remoteJobId: "remote-job-1" };
		return { status: "SENT", remoteJobId: "remote-job-1", result: { wwebjsId: "remote-message-1" } };
	} });
	await f.service.enqueue(input({ deliveryMode: "REMOTE" }));
	await f.service.processOnce();
	const firstAttemptAt = f.job()["attemptStartedAt"].getTime();
	f.advance(); await f.worker().processOnce();
	f.advance(); await f.worker().processOnce();
	assert.equal(new Set(submitted).size, 1);
	assert.deepEqual(remoteIds, [null, null, "remote-job-1"]);
	assert.equal(f.job()["attemptStartedAt"].getTime(), firstAttemptAt);
	assert.equal(f.message()["status"], "SENT");
});

test("REMOTE unknown submission stops before retention expires; unattempted old jobs may start", async () => {
	let submissions = 0;
	const f = fixture({ deliver: async () => { submissions++; throw new Error("no remote response"); } });
	await f.service.enqueue(input({ deliveryMode: "REMOTE" }));
	f.advance(48 * 60 * 60 * 1_000);
	await f.service.processOnce();
	assert.equal(submissions, 1, "queue age alone must not discard an unattempted operation");
	f.advance(23 * 60 * 60 * 1_000);
	await f.service.processOnce();
	assert.equal(submissions, 1);
	assert.equal(f.message()["status"], "UNKNOWN");
});

test("missing/oversized idempotency keys fail before persistence", async () => {
	const f = fixture();
	for (const idempotencyKey of ["", " ", "x".repeat(192)]) {
		await assert.rejects(f.service.enqueue(input({ idempotencyKey })), (error: unknown) => error instanceof OperatorOutboundRequestError && error.statusCode === 400);
	}
	assert.equal(f.db.state.messages.length, 0);
});

async function run(): Promise<void> {
	for (const [name, body] of tests) {
		await body();
		console.log(`PASS ${name}`);
	}
	console.log(`${tests.length} operator outbound tests passed (isolated; no live database/provider).`);
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });
