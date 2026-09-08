import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { normalizeMentionEntities } from "../utils/message-mention-metadata";

interface Row {
	[key: string]: any;
	mentionMetadata?: any;
	mentionEntities?: any;
	WppContact?: any;
	WppChat?: any;
	contactId?: any;
	chatId?: any;
	client?: any;
	clientId?: any;
	instance?: any;
	newText?: any;
}

/** Load the real services only after isolating every external runtime dependency. */
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
		return require(path);
	};
	const rows = new Map<number, Row>();
	const updates: Row[] = [];
	const creates: Row[] = [];
	const searches: Row[] = [];
	const sockets: Array<{ type: string; room: string; data: Row }> = [];
	let uniqueReads = 0;
	let nextId = 1;
	const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => {
		if (key === "OR") return (value as Row[]).some((condition) => matches(row, condition));
		return row[key] === value;
	});
	const databaseData = (data: Row): Row => {
		const result = { ...data };
		if (result.mentionMetadata === Prisma.DbNull) result.mentionMetadata = null;
		if (result.WppContact) { result.contactId = result.WppContact.connect.id; delete result.WppContact; }
		if (result.WppChat) { result.chatId = result.WppChat.connect.id; delete result.WppChat; }
		if (result.client) { result.clientId = result.client.connect.id; delete result.client; }
		return result;
	};
	const withRelations = (row: Row): Row => ({ ...row, WppChat: row.chatId ? { id: row.chatId } : null });
	const db = {
		wppMessage: {
			create: async ({ data }: { data: Row }) => {
				creates.push(data);
				assert.equal("mentionEntities" in data, false, "wire-only metadata never reaches Prisma input");
				const row = { id: nextId++, mentionMetadata: null, chatId: null, contactId: null, ...databaseData(data) };
				rows.set(row.id, row);
				return withRelations(row);
			},
			update: async ({ where, data }: { where: { id: number }; data: Row }) => {
				updates.push(data);
				assert.equal("mentionEntities" in data, false);
				const row = { ...rows.get(where.id)!, ...databaseData(data) };
				rows.set(where.id, row);
				return withRelations(row);
			},
			findUnique: async ({ where }: { where: { id: number } }) => { uniqueReads += 1; return rows.get(where.id) ?? null; },
			findFirst: async ({ where }: { where: Row }) => {
				searches.push(where);
				const row = [...rows.values()].find((candidate) => matches(candidate, where));
				return row ? withRelations(row) : null;
			},
		},
		wppContact: { findMany: async ({ where }: { where: Row }) => {
			assert.equal(where.instance, "tenant-a", "name resolution must be tenant scoped");
			return [{ id: 9, instance: "tenant-a", whatsappId: "88112233@lid", phone: "5511888888888", name: "Cadastro correto" }];
		} },
		internalWhatsappSender: { findMany: async () => { throw new Error("Common messages must not access internal sender names"); } },
	};
	class SilentProcess {
		log() {}
		success() {}
		failed() {}
	}
	try {
		stubDefault("./prisma.service", db);
		stubDefault("./socket.service", { emit: async (type: string, room: string, data: Row) => sockets.push({ type, room, data }) });
		stubDefault("./whatsapp.service", { editMessage: async () => undefined });
		stubDefault("../utils/processing-logger", SilentProcess);
		stubDefault("./instances.service", { executeQuery: async () => undefined });
		stubDefault("./local-sync.service", { ensureLocalTables: async () => { throw new Error("No real database fallback allowed"); } });
		stubDefault("./message-reactions.service", { hydrate: async (_instance: string, values: Row[]) => values });
		for (const path of ["./chats.service", "./contacts.service", "./message-queue.service", "./transfer-history.service", "../bots/bots-registry", "../message-flow/message-flow.factory", "../message-flow/message-flow"]) {
			stubDefault(path, {});
		}
		stubDefault("./message-queue.service", { setProcessHandler: () => undefined });
		loadFresh("./message-mentions.service");
		const presentation = loadFresh("./message-presentation.service").default;
		const messages = loadFresh("./messages.service").default;
		const distribution = loadFresh("./messages-distribution.service").default;
		const raw = "Oi @88112233 e literal @55555";
		const metadata = normalizeMentionEntities([{ id: "88112233@lid", type: "lid", displayName: "Nome do provider", phone: null }]);
		const input = { instance: "tenant-a", clientId: 3, from: "5511888888888", to: "me:account",
			body: raw, type: "chat", timestamp: "1788888000000", sentAt: new Date(1_788_888_000_000),
			status: "RECEIVED", contactId: 4, chatId: 7, wwebjsIdStanza: "MSG-MENTION", mentionEntities: metadata };
		const inserted = await messages.insertOrGetIncomingMessage(input);
		assert.equal(inserted.body, raw);
		assert.deepEqual(inserted.mentionMetadata, metadata);
		assert.deepEqual(creates[0]!.mentionMetadata, metadata);
		assert.equal(creates[0]!.client.connect.id, 3);
		const response = presentation.fromStored(inserted);
		assert.deepEqual(response.mentionEntities, metadata);
		assert.equal("mentionMetadata" in response, false, "mutation responses expose the DTO, not persistence internals");
		const currentNames = presentation.fromStored({ ...inserted,
			mentionEntities: [{ ...metadata[0], displayName: "Nome atual" }],
		});
		assert.equal(currentNames.mentionEntities[0].displayName, "Nome atual", "serializing a hydrated preview cannot restore an old stored name");

		const beforeStatusRead = uniqueReads;
		await messages.updateMessage(inserted.id, { status: "READ" });
		assert.equal(uniqueReads, beforeStatusRead, "ACK/status-only updates need no extra message read");
		assert.equal("mentionMetadata" in updates.at(-1)!, false);
		assert.deepEqual(rows.get(inserted.id)!.mentionMetadata, metadata);
		await messages.updateMessage(inserted.id, { body: raw });
		assert.equal("mentionMetadata" in updates.at(-1)!, false, "unchanged old-client body preserves metadata");
		await messages.updateMessage(inserted.id, { body: raw, mentionEntities: [] });
		assert.deepEqual(rows.get(inserted.id)!.mentionMetadata, [], "new-client explicit clear is persisted even when body did not change");
		await messages.updateMessage(inserted.id, { body: raw, mentionEntities: metadata });
		await messages.updateMessage(inserted.id, { body: "old-client edit" });
		assert.equal(updates.at(-1)!.mentionMetadata, Prisma.DbNull);
		assert.equal(rows.get(inserted.id)!.mentionMetadata, null, "old-client content edits do not leave stale mention identities");
		assert.equal("mentionEntities" in presentation.fromStored(withRelations(rows.get(inserted.id)!)), false, "unknown metadata remains absent on reload");
		const legacy = await messages.insertMessage({ ...input, wwebjsIdStanza: "OLD-CLIENT", mentionEntities: undefined });
		assert.equal("mentionMetadata" in creates.at(-1)!, false);
		assert.equal("mentionEntities" in presentation.fromStored(legacy), false);
		const empty = await messages.insertMessage({ ...input, wwebjsIdStanza: "NO-MENTIONS", mentionEntities: [] });
		assert.deepEqual(presentation.fromStored(empty).mentionEntities, []);

		const countBeforeWrongScope = updates.length;
		await distribution.processMessageEdit("wwebjs", "MSG-MENTION", "wrong tenant", { instance: "tenant-b", clientId: 3, mentionEntities: metadata });
		assert.equal(updates.length, countBeforeWrongScope);
		assert.equal(sockets.length, 0);
		await distribution.processMessageEdit("wwebjs", "MSG-MENTION", "wrong client", { instance: "tenant-a", clientId: 99, mentionEntities: metadata });
		assert.equal(updates.length, countBeforeWrongScope);
		assert.equal(sockets.length, 0);
		const editedText = `Editado ${raw}`;
		await distribution.processMessageEdit("wwebjs", "MSG-MENTION", editedText, { instance: "tenant-a", clientId: 3, mentionEntities: metadata });
		assert.equal(searches.at(-1)!.instance, "tenant-a");
		assert.equal(searches.at(-1)!.clientId, 3);
		assert.equal(sockets.at(-1)!.room, "tenant-a:chat:7");
		assert.equal(sockets.at(-1)!.data.newText, editedText);
		assert.equal(sockets.at(-1)!.data.mentionEntities[0].displayName, "Cadastro correto");
		assert.equal(sockets.at(-1)!.data.mentionEntities[0].phone, "5511888888888");
		assert.deepEqual(rows.get(inserted.id)!.mentionMetadata, metadata, "hydration enriches presentation without changing stored protocol metadata");
		await distribution.processMessageEdit("wwebjs", "MSG-MENTION", editedText, { instance: "tenant-a", clientId: 3, mentionEntities: [] });
		assert.deepEqual(sockets.at(-1)!.data.mentionEntities, []);
		await distribution.processMessageEdit("wwebjs", "MSG-MENTION", raw, { instance: "tenant-a", clientId: 3, mentionEntities: metadata });
		await distribution.processMessageEdit("wwebjs", "MSG-MENTION", "edit without metadata", { instance: "tenant-a", clientId: 3 });
		assert.equal(rows.get(inserted.id)!.mentionMetadata, null);
		assert.equal("mentionEntities" in sockets.at(-1)!.data, false, "old-client edit preserves absent/unknown semantics for frontend clearing");
		console.log("Message mention persistence/edit/socket flow tests passed");
	} finally {
		for (const [path, cached] of previous) {
			if (cached) require.cache[path] = cached;
			else delete require.cache[path];
		}
	}
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
