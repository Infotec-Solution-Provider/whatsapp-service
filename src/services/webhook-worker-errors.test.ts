import assert from "node:assert/strict";

interface TestWorker {
	activeProcessing: number;
	startProcessor(): void;
	stopProcessor(): void;
	sleep(ms: number): Promise<void>;
}
type WorkerKind = "waba" | "gupshup";
type FailureStage = "claim" | "record-failure";

const previousModules = new Map<string, NodeModule | undefined>();
function mockModule(id: string, exports: unknown): void {
	const path = require.resolve(id);
	previousModules.set(path, require.cache[path]);
	require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeModule;
}

const db: Record<string, unknown> = {};
const errors: Array<{ message: string; error: unknown }> = [];
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => { unhandled.push(error); };
let handleWebhook: () => Promise<unknown> = async () => ({ ignored: false });

mockModule("./prisma.service", { __esModule: true, default: db });
mockModule("@in.pulse-crm/utils", {
	Logger: { info: () => undefined, error: (message: string, error: unknown) => { errors.push({ message, error }); } },
	sanitizeErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
});
for (const module of ["./waba.service", "./gupshup.service"]) {
	mockModule(module, { __esModule: true, default: { handleWebhookEntry: () => handleWebhook() } });
}

const constructors = {
	waba: require("./waba-webhook-queue.service").default.constructor as new () => TestWorker,
	gupshup: require("./gupshup-webhook-queue.service").default.constructor as new () => TestWorker,
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function flush(): Promise<void> {
	// Give Node an opportunity to emit unhandledRejection as well as draining microtasks.
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function testEscapedItemFailure(kind: WorkerKind, stage: FailureStage): Promise<void> {
	const timeout = Object.assign(new Error(`Injected P2024: ${kind}/${stage}`), { code: "P2024" });
	const pendingWrite = deferred();
	const pollDelay = deferred();
	const item = { id: "webhook-1", instance: "test", payload: {}, retryCount: 0, maxRetries: 3 };
	let deliveries = 0;
	let polls = 0;
	const errorsBefore = errors.length;
	const write = async (claim: boolean) => {
		if (claim && stage === "record-failure") return;
		await pendingWrite.promise;
		throw timeout;
	};
	handleWebhook = async () => { deliveries++; throw new Error("Handler failed"); };
	db["$queryRawUnsafe"] = async (query: string) => {
		if (query.includes("ORDER BY")) polls++;
		return [item];
	};
	db["$executeRawUnsafe"] = async (query: string) => {
		await write(query.includes("processing_started_at"));
		return 1;
	};
	db["gupshupWebhookQueue"] = {
		findFirst: async () => { polls++; return item; },
		update: async ({ data }: { data: { status: string } }) => {
			await write(data.status === "PROCESSING");
			return item;
		},
		updateMany: async () => ({ count: 0 }),
	};
	const service = new constructors[kind]();
	service.sleep = () => pollDelay.promise;
	service.startProcessor();
	try {
		await flush();
		assert.equal(service.activeProcessing, 1, "Slot must stay occupied while database write is pending");
		assert.equal(errors.length, errorsBefore);
		pendingWrite.resolve();
		await flush();
		assert.equal(service.activeProcessing, 0, "Rejected item must release its slot after settling");
		assert.equal(deliveries, stage === "claim" ? 0 : 1, "Error handling must not resend the webhook");
		assert.equal(polls, 1);
		assert.deepEqual(unhandled, [], "Database failure must not escape as unhandledRejection");
		assert.equal(errors.length, errorsBefore + 1, "Escaped failure must be logged once");
		assert.equal(errors.at(-1)?.error, timeout);
	} finally {
		pendingWrite.resolve();
		service.stopProcessor();
		pollDelay.resolve();
		await flush();
	}
	console.log(`PASS ${kind}: ${stage} rejection is observed and its slot is released`);
}

async function testGupshupLoopResetFailure(): Promise<void> {
	const timeout = Object.assign(new Error("Injected P2024 while resetting stopped loop"), { code: "P2024" });
	const pollDelay = deferred();
	const errorsBefore = errors.length;
	db["gupshupWebhookQueue"] = {
		findFirst: async () => null,
		updateMany: async () => { throw timeout; },
	};
	const service = new constructors.gupshup();
	service.sleep = () => pollDelay.promise;
	service.startProcessor();
	await flush();
	service.stopProcessor();
	pollDelay.resolve();
	await flush();
	assert.deepEqual(unhandled, []);
	assert.equal(service.activeProcessing, 0);
	assert.equal(errors.length, errorsBefore + 2, "Both existing stop and loop-end resets must report failures");
	assert.ok(errors.slice(errorsBefore).some(({ message }) => message.includes("processor stopped with an error")));
	console.log("PASS gupshup: loop-end reset rejection is observed");
}

async function main(): Promise<void> {
	process.on("unhandledRejection", onUnhandled);
	try {
		for (const kind of ["waba", "gupshup"] as const) {
			for (const stage of ["claim", "record-failure"] as const) await testEscapedItemFailure(kind, stage);
		}
		await testGupshupLoopResetFailure();
	} finally {
		process.off("unhandledRejection", onUnhandled);
		for (const [path, previous] of previousModules) {
			if (previous) require.cache[path] = previous; else delete require.cache[path];
		}
	}
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
