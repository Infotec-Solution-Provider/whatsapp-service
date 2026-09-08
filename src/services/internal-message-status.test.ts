import assert from "node:assert/strict";
import { test } from "node:test";
import type { InternalMessage, SessionData } from "../sdk-local";
import type { InternalWhatsappQueueItem } from "./internal-whatsapp-message-queue.service";
import type CreateMessageDto from "../dtos/create-message.dto";

test("internal sends publish the persisted status without reloading history", async (t) => {
	const previous = new Map<string, NodeModule | undefined>();
	const stub = (path: string, exports: unknown) => {
		const resolved = require.resolve(path);
		previous.set(resolved, require.cache[resolved]);
		require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as NodeModule;
	};
	const stubDefault = (path: string, value: unknown) => stub(path, { __esModule: true, default: value });
	let row: InternalMessage;
	let syncEnabled = true;
	let linked = false;
	let queued = false;
	let remoteStatus = "SENT";
	const events: Array<{ type: string; room: string; data: Record<string, unknown>; persistedStatus: string }> = [];
	const session = { instance: "status-test", userId: 12, sectorId: 3, name: "Operator", role: "ADMIN" } as SessionData;
	const client = {
		submitMessageJob: async () => ({ jobId: "remote-1", status: remoteStatus }),
		getMessageJob: async () => ({ jobId: "remote-1", status: remoteStatus, result: { wwebjsId: "provider-1" } }),
	};
	class SilentProcess { log() {} success() {} failed() {} }
	try {
		stubDefault("./prisma.service", {
			internalMessage: {
				create: async ({ data }: { data: Record<string, unknown> }) => {
					row = { ...data, id: 42, internalChatId: 8 } as unknown as InternalMessage;
					return { ...row };
				},
				update: async ({ data }: { data: Partial<InternalMessage> }) => {
					row = { ...row, ...data };
					return { ...row };
				},
				findUnique: async () => ({ ...row }),
			},
			internalChat: { findUnique: async () => ({ id: 8, wppGroupId: linked ? "group@g.us" : null }) },
			wppSector: { findUnique: async () => ({ defaultClientId: 5 }) },
		});
		stubDefault("./socket.service", {
			emit: async (type: string, room: string, data: Record<string, unknown>) => {
				events.push({ type, room, data, persistedStatus: row.status });
			},
		});
		stubDefault("./parameters.service", { isInternalGroupWhatsappSyncEnabled: async () => syncEnabled });
		stub("./whatsapp.service", { __esModule: true, default: { getClient: () => queued ? client : {} }, getMessageType: () => "image" });
		stubDefault("./internal-whatsapp-message-queue.service", { enqueue: async () => undefined });
		stubDefault("./message-presentation.service", { hydrate: async (_instance: string, messages: InternalMessage[]) => messages });
		stubDefault("../utils/processing-logger", SilentProcess);
		stub("../utils/file-upload-trace", { createUploadTraceLogger: () => ({ info() {}, error() {} }) });
		for (const path of ["./files.service", "./users.service", "./internal-whatsapp-senders.service", "../utils/whatsapp-audio-converter"]) stubDefault(path, {});
		const servicePath = require.resolve("./internal-chats.service");
		previous.set(servicePath, require.cache[servicePath]);
		delete require.cache[servicePath];
		const service = (require("./internal-chats.service") as typeof import("./internal-chats.service")).default;
		const assertFinalEvent = (status: string) => {
			const final = events.filter((event) => event.type === "internal_message_status").at(-1);
			assert.equal(row.status, status);
			assert.deepEqual(final, {
				type: "internal_message_status", room: "status-test:internal-chat:8",
				data: { chatId: 8, internalMessageId: 42, status }, persistedStatus: status,
			});
		};
		for (const sync of [true, false]) {
			await t.test(`unlinked group, WhatsApp sync ${sync}`, async () => {
				events.length = 0;
				syncEnabled = sync;
				await service.sendMessage(session, { chatId: "8", text: "Hello" });
				assertFinalEvent("RECEIVED");
			});
		}
		syncEnabled = true;
		linked = true;
		for (const outcome of ["success", "missing-id", "error"]) {
			await t.test(`direct WhatsApp send: ${outcome}`, async () => {
				events.length = 0;
				service.sendMessageToWppGroup = async () => {
					if (outcome === "error") throw new Error("Provider failed");
					return outcome === "success" ? { wwebjsId: "provider-1" } as CreateMessageDto : undefined;
				};
				await service.sendMessage(session, { chatId: "8", text: "Hello" });
				assertFinalEvent(outcome === "success" ? "RECEIVED" : "ERROR");
			});
		}
		await t.test("queued confirmation replaces PENDING with persisted status", async () => {
			events.length = 0;
			queued = true;
			await service.sendMessage(session, { chatId: "8", text: "Hello" });
			assertFinalEvent("PENDING");
			const item = {
				id: "queue-1", instance: session.instance, internalChatId: 8, internalMessageId: 42,
				groupId: "group@g.us", messageData: JSON.stringify({ clientId: 5, session, data: {}, remoteJobId: "remote-1" }),
			} as InternalWhatsappQueueItem;
			remoteStatus = "PROCESSING";
			assert.deepEqual(await service.processQueuedWppGroupMessage(item), { status: "PENDING" });
			assertFinalEvent("PENDING");
			remoteStatus = "SENT";
			assert.deepEqual(await service.processQueuedWppGroupMessage(item), { status: "COMPLETED" });
			assertFinalEvent("RECEIVED");
		});
	} finally {
		for (const [path, cached] of previous) {
			if (cached) require.cache[path] = cached;
			else delete require.cache[path];
		}
	}
});
