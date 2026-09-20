import assert from "node:assert/strict";
import type WhatsappClient from "../whatsapp-client/whatsapp-client";
import type { SendTextOptions } from "../types/whatsapp-instance.types";
import type { HealthCheckDependencies } from "./wwebjs-health-check.service";
import registry from "./functional-health-probe-registry.service";
import { createFunctionalHealthCallbackData } from "../utils/functional-health-status";

async function run(): Promise<void> {
	const previous = new Map<string, NodeModule | undefined>();
	const stub = (path: string, exports: unknown) => {
		const id = require.resolve(path);
		previous.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
	};
	const replaceDefault = (path: string, value: unknown) => stub(path, { __esModule: true, default: value });
	const fresh = (path: string) => {
		const id = require.resolve(path);
		previous.set(id, require.cache[id]);
		delete require.cache[id];
		return require(id);
	};
	const correlationId = "8cc5cf6d-cacb-409a-871d-54842f31a7ed";
	const callback = createFunctionalHealthCallbackData(6, correlationId);
	const payload = (status: string, data?: unknown) => ({ entry: [{ changes: [{ value: {
		statuses: [{ id: "wamid.health", status, timestamp: "1789864207", recipient_id: "555133575071",
			...(data === undefined ? {} : { biz_opaque_callback_data: data }),
			...(status === "failed" ? { errors: [{ code: 131000, message: "Provider failure" }] } : {}) }],
	} }] }] });
	const failedLogs: unknown[] = [];
	const statusCalls: unknown[][] = [];
	const writes: unknown[][] = [];
	let queuedPayload: unknown = payload("delivered", callback);
	let missingMessage = false;
	const missingError = Object.assign(new Error("Message not found"), { name: "MessageStatusTargetNotFoundError" });
	try {
		stub("@in.pulse-crm/utils", { Logger: { info() {}, warning() {}, error() {} },
			sanitizeErrorMessage: (error: Error) => error.message });
		replaceDefault("../utils/processing-logger", class {
			processName = "waba-webhook-entry";
			log() {} success() {} failed(error: unknown) { failedLogs.push(error); }
		});
		replaceDefault("./prisma.service", {
			wppClient: { findFirstOrThrow: async () => ({ id: 6, instance: "tenant" }) },
			$queryRawUnsafe: async () => [{ id: "queue-id", instance: "tenant", payload: queuedPayload, retryCount: 0, maxRetries: 30 }],
			$executeRawUnsafe: async (...args: unknown[]) => { writes.push(args); return 1; },
		});
		for (const path of ["./chats.service", "./messages.service", "./files.service", "./whatsapp.service"]) {
			replaceDefault(path, new Proxy({}, { get() { throw new Error(`Unexpected dependency: ${path}`); } }));
		}
		replaceDefault("../whatsapp-client/waba-whatsapp-client", class {});
		replaceDefault("./messages-distribution.service", {
			processMessageStatus: async (...args: unknown[]) => {
				statusCalls.push(args);
				if (missingMessage) throw missingError;
			},
		});
		const waba: typeof import("./waba.service").default = fresh("./waba.service").default;
		const { WwebjsHealthCheckService }: typeof import("./wwebjs-health-check.service") = fresh("./wwebjs-health-check.service");
		let sentOptions: SendTextOptions | undefined;
		const official = { id: 6, instance: "tenant", _phone: "554733314005", sendMessage: async (options: SendTextOptions) => {
			sentOptions = options;
			// A callback can arrive before the send response, while the probe is still active.
			assert.equal((await waba.handleWebhookEntry("tenant", payload("sent", options.wabaCallbackData))).ignored, true);
		} } as unknown as WhatsappClient;
		const primary = { id: 10, sendMessage: async (options: SendTextOptions) => {
			await registry.handleOfficialInbound({ clientId: 6, instance: "tenant", from: "555133575071", body: options.text });
		} } as unknown as WhatsappClient;
		const dependencies: HealthCheckDependencies = {
			getClient: (id) => id === 6 ? official : primary,
			isOfficialClient: (client) => client === official,
			now: () => new Date(), randomId: () => correlationId,
			sleep: async () => { throw new Error("Unexpected probe timeout"); },
			probeTimeoutMs: 60000, probePollIntervalMs: 1, resultTtlMs: 60000, officialClientId: 6,
			createApiClient: () => ({
				listSessions: async () => [{ sessionId: "primary", clientId: 10, instance: "tenant", library: "BAILEYS",
					enabled: true, isDefault: true, monitorGroupId: null, monitorRole: "PRIMARY", monitoringEnabled: true,
					runtimeStatus: "open", available: true, lastError: null }],
				getSessionInfo: async () => ({ phone: "555133575071", status: "open" }),
				getProbeStatus: async () => ({ received: true }), forceReconnect: async () => {},
			}),
		};
		const results = await new WwebjsHealthCheckService(dependencies).runHealthCheck();
		assert.equal(results[0]?.receiveStatus, "PASSED");
		assert.equal(results[0]?.responseDispatchStatus, "PASSED");
		assert.equal(sentOptions?.wabaCallbackData, callback);
		assert.equal(registry.getSnapshot(correlationId), null, "probe has already been removed");

		// Delayed/repeated callbacks need no pending registration or message row.
		for (const status of ["sent", "delivered", "read", "failed", "delivered"]) {
			assert.equal((await waba.handleWebhookEntry("tenant", payload(status, callback))).ignored, true);
		}
		assert.equal(statusCalls.length, 0);
		assert.equal(failedLogs.length, 0);
		for (const data of [undefined, null, 123, {}, "", "HEALTHPROBE:anything", `${callback}:extra`,
			"inpulse:health-probe:v1:6:", createFunctionalHealthCallbackData(7, correlationId)]) {
			assert.equal((await waba.handleWebhookEntry("tenant", payload("delivered", data))).ignored, false);
			assert.deepEqual(statusCalls.at(-1), ["waba", "wamid.health", "RECEIVED", {
				statusTimestamp: "1789864207", throwIfNotFound: true,
			}]);
		}
		missingMessage = true;
		await assert.rejects(waba.handleWebhookEntry("tenant", payload("delivered")), (error) => error === missingError);

		// Exercise the real durable queue transition: probe -> IGNORED; unknown message -> retry.
		const queue = fresh("./waba-webhook-queue.service").default as { processItem(id: string): Promise<void> };
		await queue.processItem("queue-id");
		assert.equal(writes.at(-1)?.[1], "IGNORED");
		queuedPayload = payload("delivered");
		await queue.processItem("queue-id");
		assert.equal(writes.at(-1)?.[1], "PENDING");
		assert.equal(writes.at(-1)?.[2], 1);
		console.log("waba-health-status: round trip, early/delayed callbacks, strict marker scope and durable queue transitions passed");
	} finally {
		registry.unregister(correlationId);
		for (const [id, cached] of previous) { if (cached) require.cache[id] = cached; else delete require.cache[id]; }
	}
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
