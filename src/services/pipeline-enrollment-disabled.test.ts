import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { normalizeMentionEntities } from "../utils/message-mention-metadata";

type Row = Record<string, any>;

async function run(): Promise<void> {
	const previous = new Map<string, NodeModule | undefined>();
	const isolate = (path: string, exports: unknown) => {
		const resolved = require.resolve(path);
		if (!previous.has(resolved)) previous.set(resolved, require.cache[resolved]);
		require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as NodeModule;
	};
	const stubDefault = (path: string, value: unknown) => isolate(path, { __esModule: true, default: value });
	const loadFresh = (path: string) => {
		const resolved = require.resolve(path);
		if (!previous.has(resolved)) previous.set(resolved, require.cache[resolved]);
		delete require.cache[resolved];
		return require(path).default;
	};
	const rows = new Map<number, Row>();
	const localWrites: Array<{ instance: string; query: string; values: unknown[] }> = [];
	const readyMessageReads: Row[] = [];
	const contactScopeReads: Row[] = [];
	const notifications: Row[] = [];
	const queued: Row[] = [];
	let handler: Row | undefined;
	let forbiddenAccesses = 0;
	let messageReads = 0;
	let nextId = 1;
	const forbidden = (operation: string): never => {
		forbiddenAccesses++;
		throw new Error(`Disabled pipeline dependency must not be accessed: ${operation}`);
	};
	const databaseData = (data: Row): Row => {
		const result = { ...data };
		if (result["mentionMetadata"] === Prisma.DbNull) result["mentionMetadata"] = null;
		for (const [relation, field] of [["WppContact", "contactId"], ["WppChat", "chatId"], ["client", "clientId"]] as const) {
			if (result[relation]) { result[field] = result[relation].connect.id; delete result[relation]; }
		}
		return result;
	};
	const client = { id: 3, instance: "tenant-a", isActive: true, type: "WABA", _phone: "5511999999999" };
	const db = {
		get pipelineEnrollmentOutbox(): never { return forbidden("pipelineEnrollmentOutbox"); },
		$transaction: async () => forbidden("pipeline-only interactive transaction"),
		wppMessage: {
			create: async ({ data }: { data: Row }) => {
				assert.equal("mentionEntities" in data, false);
				const row = { id: nextId++, ...databaseData(data) };
				rows.set(row.id, row);
				return row;
			},
			update: async ({ where, data }: { where: { id: number }; data: Row }) => {
				assert.equal("mentionEntities" in data, false);
				const row = { ...rows.get(where.id), ...databaseData(data), id: where.id };
				rows.set(where.id, row);
				return row;
			},
			findUnique: async ({ where }: { where: { id: number } }) => { messageReads++; return rows.get(where.id); },
		},
		wppClient: { findFirst: async ({ where }: { where: Row }) => {
			assert.deepEqual(where, { id: 3, instance: "tenant-a", isActive: true });
			return client;
		} },
		wppContact: {
			findUnique: async () => forbidden("pipeline customerId enrichment"),
			findFirst: async ({ where }: { where: Row }) => {
				contactScopeReads.push(where);
				return { id: 4, instance: "tenant-a" };
			},
		},
		readyMessage: { findFirst: async ({ where }: { where: Row }) => {
			readyMessageReads.push(where);
			return { id: 12, instance: "tenant-a", sectorId: 7, onlyAdmin: false };
		} },
	};
	class SilentProcess {
		log() {}
		success() {}
		failed() {}
	}
	try {
		stubDefault("./prisma.service", db);
		stubDefault("./socket.service", {});
		isolate("./whatsapp.service", { __esModule: true, default: { getClient: () => client }, getMessageType: () => "chat" });
		stubDefault("../utils/processing-logger", SilentProcess);
		stubDefault("./instances.service", { executeQuery: async (instance: string, query: string, values: unknown[]) => {
			localWrites.push({ instance, query, values });
		} });
		stubDefault("./local-sync.service", { ensureLocalTables: async () => forbidden("local fallback must not be needed") });
		stubDefault("./message-mentions.service", {});
		stubDefault("./files.service", {});
		stubDefault("./messages-distribution.service", { notifyMessage: async (_process: unknown, message: Row) => { notifications.push(message); } });
		stubDefault("./operator-outbound.service", {
			setHandler: (value: Row) => { handler = value; },
			lookup: async () => null,
			enqueue: async (input: Row) => {
				queued.push(input);
				return { created: true, message: { id: nextId++, ...input["message"] } };
			},
		});
		const messages = loadFresh("./messages.service");
		loadFresh("./ready-messages.service");
		const operator = loadFresh("./operator-send.service");
		const metadata = normalizeMentionEntities([{ id: "88112233@lid", type: "lid", displayName: "Contato", phone: null }]);
		const base = { instance: "tenant-a", clientId: 3, from: "me:5511999999999", to: "5511888888888",
			body: "Olá @88112233", type: "chat", timestamp: "1788888000000", sentAt: new Date(1_788_888_000_000),
			status: "SENT", contactId: 4, userId: 8, mentionEntities: metadata };

		// Extra historical metadata cannot revive the disconnected pipeline side effect.
		const template = await messages.insertMessage({ ...base, wabaId: "template-provider-id" }, {
			sourceType: "WHATSAPP_TEMPLATE", sourceKey: "template:waba:welcome:pt_br",
		});
		assert.equal(template.wabaId, "template-provider-id");
		assert.equal(template.contactId, 4);
		assert.equal(template.clientId, 3);
		assert.deepEqual(template.mentionMetadata, metadata);
		assert.equal(localWrites.length, 2, "Template persistence must still synchronize the local message and preview tables");
		assert.equal(localWrites[0]!.instance, "tenant-a");
		assert.match(localWrites[0]!.query, /INSERT INTO wpp_messages/);
		assert.match(localWrites[1]!.query, /INSERT INTO wpp_last_messages/);
		assert.equal(forbiddenAccesses, 0);
		console.log("PASS template message persists and synchronizes without pipeline transaction or customer lookup");

		const pending = await messages.insertMessage({ ...base, status: "PENDING" });
		const ready = await messages.updateMessage(pending.id, { status: "SENT", wabaId: "ready-provider-id" }, false, {
			sourceType: "READY_MESSAGE", sourceKey: "ready-message:12",
		});
		assert.equal(ready.status, "SENT");
		assert.equal(ready.wabaId, "ready-provider-id");
		assert.deepEqual(ready.mentionMetadata, metadata);
		assert.equal(messageReads, 0, "Status-only persistence must not add a message lookup");
		assert.equal(localWrites.length, 6);
		assert.equal(forbiddenAccesses, 0);
		console.log("PASS ready-message result persists provider receipt and mentions without pipeline access");

		operator.configureWorker();
		assert.ok(handler);
		await handler["finalize"]?.(db, ready, {
			options: { to: base.to, text: base.body },
			pipelineSource: { sourceType: "READY_MESSAGE", sourceKey: "ready-message:12" },
		});
		await handler["onMessage"](ready);
		assert.equal(forbiddenAccesses, 0);
		assert.equal(localWrites.length, 8);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0], ready);
		console.log("PASS existing outbound payload cannot recreate an outbox event; local sync and notification remain");

		const session = { instance: "tenant-a", userId: 8, sectorId: 7, role: "USER", name: "Operador" };
		const accepted = await operator.submit(session, 3, base.to, {
			text: "Mensagem pronta", contactId: 4, readyMessageId: 12,
		}, "persisted-send-key");
		assert.equal(accepted.created, true);
		assert.deepEqual(readyMessageReads, [{ id: 12, instance: "tenant-a" }], "Ready-message authorization must remain scoped");
		assert.deepEqual(contactScopeReads, [{ id: 4, instance: "tenant-a" }], "Contact access validation must remain scoped");
		assert.equal(queued.length, 1);
		assert.equal("pipelineSource" in queued[0]!["payload"], false);
		assert.equal(queued[0]!["message"].body, "*Operador*: Mensagem pronta");
		assert.equal(forbiddenAccesses, 0);
		console.log("PASS ready-message submission keeps authorization and content without producing pipeline metadata");
	} finally {
		for (const [path, cached] of previous) {
			if (cached) require.cache[path] = cached; else delete require.cache[path];
		}
	}
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
