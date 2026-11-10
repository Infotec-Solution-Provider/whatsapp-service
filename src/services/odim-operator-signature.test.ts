import assert from "node:assert/strict";
import type { SessionData } from "../sdk-local";
import type { SendMessageOptions } from "../types/whatsapp-instance.types";
import type { OperatorOutboundEnqueueInput, OperatorOutboundHandler } from "./operator-outbound.types";

async function run(): Promise<void> {
	const previous = new Map<string, NodeModule | undefined>();
	const isolate = (path: string, exports: unknown) => {
		const resolved = require.resolve(path);
		if (!previous.has(resolved)) previous.set(resolved, require.cache[resolved]);
		require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as NodeModule;
	};
	const stub = (path: string, value: unknown) => isolate(path, { __esModule: true, default: value });
	const unexpected = (path: string) => new Proxy({}, { get() { throw new Error(`Unexpected dependency: ${path}`); } });
	const persisted: OperatorOutboundEnqueueInput[] = [];
	const bodies: any[] = [];
	const legacyMessages: any[] = [];
	const records = new Map<string, any>();
	let currentClient: any;
	let currentSession: SessionData;
	let handler: OperatorOutboundHandler | undefined;
	class SilentProcess { log() {} success() {} failed() {} }
	try {
		isolate("dotenv/config", {});
		isolate("@in.pulse-crm/utils", { Logger: { info() {}, debug() {}, error() {} },
			sanitizeErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) });
		stub("../utils/processing-logger", SilentProcess);
		stub("axios", { post: async (_url: string, body: unknown) => {
			bodies.push(structuredClone(body));
			return { data: { messages: [{ id: `wamid.synthetic-${bodies.length}` }] } };
		} });
		for (const path of ["./instances.service", "./internal-chats.service", "./contacts.service", "./ready-messages.service",
			"./message-presentation.service", "./odim-operational-channel.service", "../adapters/template.adapter"])
			stub(path, unexpected(path));
		for (const provider of ["gupshup", "remote", "wwebjs"])
			stub(`../whatsapp-client/${provider}-whatsapp-client`, class {});
		stub("./prisma.service", {
			wppClient: { findFirst: async () => ({ id: 13, instance: currentSession.instance, type: "WABA", isActive: true }) },
			wppContact: { findFirst: async () => ({ id: 42, instance: currentSession.instance }) },
			wppChat: { findFirst: async () => ({ id: 84, contactId: 42, instance: currentSession.instance }) },
		});
		stub("./files.service", {
			fetchFileMetadata: async () => ({ id: 7, name: "synthetic.png", mime_type: "image/png", size: 123, public_id: "synthetic" }),
			getWabaMedia: async () => "synthetic-media-id",
			getFileDownloadUrl: () => "http://synthetic.invalid/7",
			getPublicFileUrl: () => "http://synthetic.invalid/public/7",
		});
		stub("./messages.service", {
			insertMessage: async (message: any) => { legacyMessages.push(structuredClone(message)); return { id: 420, ...message }; },
			updateMessage: async (id: number, message: any) => ({ id, ...message }),
			syncMessageToLocal: async () => undefined,
		});
		stub("./messages-distribution.service", { notifyMessage: async () => undefined });
		stub("./operator-outbound.service", {
			setHandler: (value: OperatorOutboundHandler) => { handler = value; },
			lookup: async (scope: { instance: string; userId: number }, key: string) => records.get(`${scope.instance}:${scope.userId}:${key}`) ?? null,
			enqueue: async (input: OperatorOutboundEnqueueInput) => {
				persisted.push(structuredClone(input));
				const record = { created: true, message: { id: persisted.length, ...input.message }, job: {
					id: `job-${persisted.length}`, instance: input.instance, userId: input.userId, clientId: input.clientId,
					payloadHash: input.payloadHash, payload: input.payload, deliveryMode: input.deliveryMode, remoteJobId: null,
				} };
				records.set(`${input.instance}:${input.userId}:${input.idempotencyKey}`, record);
				return record;
			},
		});
		for (const path of ["../whatsapp-client/waba-whatsapp-client", "./whatsapp.service", "./operator-send.service"]) {
			const resolved = require.resolve(path);
			previous.set(resolved, require.cache[resolved]);
			delete require.cache[resolved];
		}
		const WabaClient = (require("../whatsapp-client/waba-whatsapp-client") as typeof import("../whatsapp-client/waba-whatsapp-client")).default;
		const whatsapp = (require("./whatsapp.service") as typeof import("./whatsapp.service")).default;
		const sender = (require("./operator-send.service") as typeof import("./operator-send.service")).default;
		Object.defineProperty(whatsapp, "getClient", { value: () => currentClient });
		sender.configureWorker();
		assert.ok(handler);
		const cases = [
			{ instance: "odim", userId: 6, expected: "Supervisão" },
			{ instance: "odim", userId: 9, expected: "Supervisão" },
			{ instance: "ODIM", userId: 9, expected: "Supervisão" },
			{ instance: "odim", userId: 10, expected: "Nome sintético" },
			{ instance: "outro-tenant", userId: 6, expected: "Nome sintético" },
		];
		for (const [index, scenario] of cases.entries()) {
			currentSession = { ...scenario, name: "Nome sintético", sectorId: 1, role: "ADMIN" } as SessionData;
			currentClient = new WabaClient(13, scenario.instance, "Synthetic", "5500000000000", "synthetic-phone-id", "synthetic-account-id", "synthetic-token");
			const request = { text: "Mensagem sintética", contactId: 42, chatId: 84 };
			const expected = `*${scenario.expected}*: Mensagem sintética`;
			const record = await sender.submit(currentSession, 13, "5500000000001", request, `synthetic-${index}`);
			assert.equal(record.message.body, expected);
			assert.equal(record.message.userId, scenario.userId, "shared signature must retain the authenticated author");
			const job = { ...record.job, message: record.message } as Parameters<OperatorOutboundHandler["deliver"]>[0];
			const delivered = await handler.deliver(job);
			assert.equal(delivered.status, "SENT");
			assert.equal(bodies.at(-1).text.body, expected, "real WABA adapter must emit the persisted signature");
			const previousPersists = persisted.length;
			const previousRequests = bodies.length;
			const replay = await sender.submit({ ...currentSession, name: "Nome alterado" }, 13, "5500000000001", request, `synthetic-${index}`);
			assert.equal(replay.created, false);
			assert.equal(replay.message.body, expected);
			assert.equal(persisted.length, previousPersists, "replay cannot rewrite the signature");
			assert.equal(bodies.length, previousRequests, "replay cannot send again");
			await assert.rejects(() => sender.submit(currentSession, 13, "5500000000001", { ...request, text: "Diferente" }, `synthetic-${index}`));
			if (scenario.instance === "odim" && scenario.userId === 6) {
				const media = await sender.submit(currentSession, 13, "5500000000001", { ...request, fileId: 7 }, "synthetic-media");
				await handler.deliver({ ...media.job, message: media.message } as Parameters<OperatorOutboundHandler["deliver"]>[0]);
				assert.equal(bodies.at(-1).image.caption, expected, "real WABA media caption must use the shared signature");
			}
			let remoteOptions: SendMessageOptions | undefined;
			currentClient = { id: 13, instance: scenario.instance, _phone: "5500000000000", sendMessage: async (options: SendMessageOptions) => {
				remoteOptions = options;
				return { wwebjsId: "synthetic-remote-id" };
			} };
			const legacy = await whatsapp.sendMessage(currentSession, 13, "5500000000001", request);
			assert.equal(remoteOptions?.text, expected, "legacy REMOTE boundary must receive the shared signature");
			assert.equal(legacyMessages.at(-1).body, expected);
			assert.equal(legacy.userId, scenario.userId);
		}
		console.log("odim-operator-signature: real durable send/WABA body+caption, legacy REMOTE send, author isolation and replay passed");
	} finally {
		for (const [path, cached] of previous) {
			if (cached) require.cache[path] = cached;
			else delete require.cache[path];
		}
	}
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
