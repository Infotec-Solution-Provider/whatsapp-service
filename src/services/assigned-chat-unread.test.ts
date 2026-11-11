import assert from "node:assert/strict";
import test from "node:test";

// Load real services against isolated storage/transport doubles. No env, network or workers.
const saved = new Map<string, NodeModule | undefined>();
const stub = (path: string, value: unknown) => {
	const id = require.resolve(path);
	saved.set(id, require.cache[id]);
	require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
};
type Row = { id: number; instance: string; userId: number | null; contactId: number; sectorId: number; isFinished: boolean };
let row: Row = { id: 1, instance: "exatron", userId: 2, contactId: 10, sectorId: 5, isFinished: false };
let prefs = new Map<string, { isPinned: boolean; isMarkedUnread: boolean }>();
let failPreference = false;
const key = (v: any) => `${v.instance}:${v.userId}:${v.chatType}:${v.chatId}`;
const emitted: any[] = [];
const db: any = {
	wppChat: {
		findUnique: async () => ({ ...row }),
		findMany: async () => [{ ...row, contact: { id: 10, customerId: null }, schedule: null }],
		findFirst: async () => ({ ...row }),
		update: async ({ data }: any) => Object.assign(row, data),
		create: async ({ data }: any) => (row = { ...row, ...data })
	},
	wppMessage: { groupBy: async () => [], findMany: async () => [], updateMany: async ({ where }: any) => { assert.equal(where.instance, "exatron"); return { count: 0 }; } },
	chatUserPreference: {
		findMany: async ({ where }: any) => { const pref = prefs.get(key({ ...where, chatId: 1 })); return pref ? [{ chatId: 1, ...pref }] : []; },
		upsert: async ({ where, create, update }: any) => {
			if (failPreference) throw new Error("preference write failed");
			const id = key(where.instance_userId_chatType_chatId);
			prefs.set(id, { isPinned: false, ...(prefs.get(id) ?? create), ...update });
		},
		updateMany: async ({ where, data }: any) => {
			const id = key(where);
			if (prefs.has(id)) prefs.set(id, { ...prefs.get(id)!, ...data });
		}
	},
	$transaction: async (write: (tx: any) => Promise<unknown>) => {
		const before = { ...row }; const beforePrefs = structuredClone(prefs);
		try { return await write(db); } catch (error) { row = before; prefs = beforePrefs; throw error; }
	}
};
const noop = async () => {};
const chatDouble = { syncChatToLocal: noop };
const distributionDouble = { addSystemMessage: noop, notifyChatStarted: noop };
const logger = { log() {}, success() {}, failed() {} };
stub("./prisma.service", db);
stub("./socket.service", { emit: async (_event: string, _room: string, data: unknown) => { emitted.push(data); } });
stub("./instances.service", { executeQuery: async () => { throw new Error("wpp_messages doesn't exist"); } });
stub("./local-sync.service", { ensureLocalTables: noop });
stub("./whatsapp.service", {});
stub("./contacts.service", { resolveContactAddress: () => null });
stub("./parameters.service", {});
stub("./message-queue.service", { setProcessHandler() {} });
stub("./message-presentation.service", { hydrate: async (_instance: string, values: unknown[]) => values });
stub("./message-mentions.service", {});
stub("./public-report-fields.service", {});
stub("./transfer-history.service", { recordTransfer: noop });
stub("./users.service", () => ({ setAuth() {}, getUserById: async () => ({ NOME: "Operator" }) }));
stub("../utils/processing-logger", class { log() {} success() {} failed() {} });
stub("../message-flow/message-flow.factory", {});
stub("../bots/bots-registry", {});
stub("../bots/exatron-satisfaction.bot", {});
stub("./chats.service", chatDouble);
stub("./messages.service", {});
stub("./messages-distribution.service", distributionDouble);

function real<T>(path: string): T {
	const id = require.resolve(path); delete require.cache[id];
	return require(path).default as T;
}
const preferences = real<typeof import("./chat-user-preferences.service").default>("./chat-user-preferences.service");
const distribution = real<typeof import("./messages-distribution.service").default>("./messages-distribution.service");
// ChatsService imports only the side-effect-free distribution double.
stub("./messages-distribution.service", distributionDouble);
const chats = real<typeof import("./chats.service").default>("./chats.service");
chats.syncChatToLocal = noop;
const messages = real<typeof import("./messages.service").default>("./messages.service");
const session = { instance: "exatron", userId: 7, sectorId: 5, role: "RECEP", name: "Operator" };
const recipient = () => prefs.get("exatron:7:wpp:1");

test("assignment persists recipient unread, survives old reads and clears on own read", async () => {
	prefs.set("exatron:7:wpp:1", { isPinned: true, isMarkedUnread: false });
	await chats.transferAttendance("test", { instance: "exatron", userId: 2, sectorId: 5, role: "RECEP", name: "Operator" }, 1, 7);
	assert.equal(row.userId, 7);
	assert.deepEqual(recipient(), { isPinned: true, isMarkedUnread: true });
	for (let poll = 0; poll < 3; poll++) {
		const summary = await chats.getUserChatsBySession(session, false, true, [1]);
		assert.equal(summary.chats[0]?.isUnread, true, "HTTP summary stays unread despite all messages read");
	}
	// All messages can already be READ (updateMany returns zero). A previous owner reading
	// must not acknowledge the new recipient's arrival preference.
	const originalError = console.error; console.error = () => {};
	try {
		await messages.markContactMessagesAsRead("exatron", 10, 2);
		assert.equal(recipient()?.isMarkedUnread, true);
		await messages.markContactMessagesAsRead("exatron", 10, 7);
		assert.equal(recipient()?.isMarkedUnread, false, "clears even when CRM mirror recovery returns early");
		assert.equal((await chats.getUserChatsBySession(session, false, true, [1])).chats[0]?.isUnread, false);
	} finally { console.error = originalError; }
	assert.deepEqual(emitted.at(-1), { contactId: 10, userId: 7 });
	await chats.transferAttendance("test", { instance: "exatron", userId: 7, sectorId: 5, role: "RECEP", name: "Operator" }, 1, 7);
	assert.equal(recipient()?.isMarkedUnread, true, "reassignment rearms a previously acknowledged chat");
});

test("new received chat and automatic transfers use durable recipient unread", async () => {
	(distribution as any).getFlow = async () => ({ getChatPayload: async () => ({ instance: "exatron", userId: 7, contactId: 10, sectorId: 5, type: "RECEPTIVE" }) });
	(distribution as any).addSystemMessage = noop;
	(distribution as any).notifyChatStarted = noop;
	const sector = { id: 5, instance: "exatron", name: "Sector" } as any;
	const contact = { id: 10 } as any;
	const message = { id: 5, status: "READ" } as any;
	prefs.clear();
	await distribution.createNewChat("exatron", [sector], contact, message, logger as any, true);
	assert.equal(recipient()?.isMarkedUnread, true);
	await preferences.markRead({ instance: "exatron", userId: 7 }, "wpp", 1);
	await distribution.transferChatSector(sector, contact, row as any, message);
	assert.equal(recipient()?.isMarkedUnread, true);
	await preferences.markRead({ instance: "exatron", userId: 7 }, "wpp", 1);
	await distribution.transferChatOperator(sector, { CODIGO: 7 } as any, contact, row as any, message);
	assert.equal(recipient()?.isMarkedUnread, true);
});

test("system-created chats start unread for the assigned attendant", async () => {
	(chats as any).checkIfChatExistsOrThrow = noop;
	prefs.clear();
	await chats.systemStartNewChat({ instance: "exatron", sectorId: 5, userId: 7, contact: { id: 10 } as any });
	assert.equal(recipient()?.isMarkedUnread, true);
});

test("failed preference write rolls back the assignment, and sentinel users are not preferences", async () => {
	const before = { ...row }; failPreference = true;
	await assert.rejects(preferences.withUnreadAssignment((tx) => tx.wppChat.update({ where: { id: 1 }, data: { userId: 8 } })), /preference write failed/);
	assert.deepEqual(row, before);
	failPreference = false;
	const size = prefs.size;
	for (const userId of [null, -1, 0]) {
		await preferences.withUnreadAssignment(async () => ({ ...row, userId }));
	}
	assert.equal(prefs.size, size);
});

test.after(() => { for (const [id, previous] of saved) { if (previous) require.cache[id] = previous; else delete require.cache[id]; } });
