import assert from "node:assert/strict";
import type { WppChat } from "@prisma/client";
import type { SessionData } from "../sdk-local";
import type WhatsappService from "./whatsapp.service";
import { WabaDeliveryError } from "../utils/waba-send";

async function run(): Promise<void> {
	const previous = new Map<string, NodeModule | undefined>();
	const isolate = (path: string, exports: unknown) => {
		const resolved = require.resolve(path);
		previous.set(resolved, require.cache[resolved]);
		require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as NodeModule;
	};
	const stub = (path: string, value: unknown) => isolate(path, { __esModule: true, default: value });
	const timer = globalThis.setTimeout;
	const inserted: Array<Record<string, unknown>> = [];
	const updates: Array<{ id: number; status: string }> = [];
	const notified: string[] = [];
	let sends = 0;
	let failure = new WabaDeliveryError("FAILED", "A Meta recusou a mídia.");
	class SilentProcess { log() {} success() {} failed() {} }
	try {
		isolate("@in.pulse-crm/utils", {
			Logger: { info() {}, debug() {}, error() {} },
			sanitizeErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
		});
		stub("../utils/processing-logger", SilentProcess);
		for (const path of ["./prisma.service", "./files.service", "./instances.service", "./internal-chats.service", "./contacts.service", "./ready-messages.service"])
			stub(path, new Proxy({}, { get() { throw new Error(`Unexpected external dependency: ${path}`); } }));
		for (const provider of ["gupshup", "remote", "waba", "wwebjs"])
			stub(`../whatsapp-client/${provider}-whatsapp-client`, class {});
		stub("./messages.service", {
			insertMessage: async (data: Record<string, unknown>) => {
				inserted.push(data);
				return { id: 42, ...data };
			},
			updateMessage: async (id: number, data: { status: string }) => {
				updates.push({ id, status: data.status });
				return { id, ...inserted.at(-1), ...data };
			},
		});
		stub("./messages-distribution.service", {
			notifyMessage: async (_process: unknown, message: { status: string }) => { notified.push(message.status); },
		});
		const path = require.resolve("./whatsapp.service");
		previous.set(path, require.cache[path]);
		delete require.cache[path];
		const service: typeof WhatsappService = require(path).default;
		Object.defineProperty(service, "getClient", { value: () => ({ id: 6, instance: "karsten", _phone: "554733314005",
			sendMessage: async () => { sends++; throw failure; },
		}) });
		// Only the artificial bot typing delay runs on a timer in this isolated harness.
		globalThis.setTimeout = ((callback: () => void) => { queueMicrotask(callback); return 0; }) as unknown as typeof setTimeout;
		for (const method of ["operator", "bot"] as const) {
			for (const deliveryStatus of ["FAILED", "UNKNOWN"] as const) {
				inserted.length = updates.length = notified.length = sends = 0;
				failure = new WabaDeliveryError(deliveryStatus, `Provider outcome ${deliveryStatus}`);
				const promise = method === "operator"
					? service.sendMessage({ instance: "karsten", name: "Ana", userId: 22 } as SessionData, 6,
						"5511993104505", { contactId: 86448, chatId: 234740, text: "Teste" })
					: service.sendBotMessage("5511993104505", 6, {
						chat: { id: 234740, instance: "karsten", contactId: 86448, sectorId: 1 } as WppChat, text: "Teste",
					});
				await assert.rejects(promise);
				const expected = deliveryStatus === "FAILED" ? "ERROR" : "UNKNOWN";
				assert.equal(inserted.length, 1);
				assert.equal(inserted[0]!["status"], "PENDING");
				assert.deepEqual(updates, [{ id: 42, status: expected }], `${method} must preserve provider certainty`);
				assert.deepEqual(notified, method === "operator" ? ["PENDING", expected] : [expected]);
				assert.equal(sends, 1, `${method} must never retry a failed or uncertain dispatch`);
			}
		}
		console.log("waba-legacy-send-status: real operator/bot methods preserve FAILED vs UNKNOWN and never resend (4 cases)");
	} finally {
		globalThis.setTimeout = timer;
		for (const [path, cached] of previous) {
			if (cached) require.cache[path] = cached;
			else delete require.cache[path];
		}
	}
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
