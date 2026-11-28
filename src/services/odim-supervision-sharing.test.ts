import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SessionData } from "../sdk-local";
import type { JournalRow } from "./session-changes/session-change-reader";
import { keepsOdimSupervisionAccess, odimSupervisionPeer } from "../utils/odim-supervision-sharing";
import { cursorScope, decodeCursor, encodeCursor } from "./session-changes/session-change-cursor";

type Row = Record<string, any>;
const matches = (row: Row | null, where: Row): boolean => !!row && Object.entries(where).every(([key, value]) => {
	if (key === "OR") return value.some((branch: Row) => matches(row, branch));
	if (key === "AND") return value.every((branch: Row) => matches(row, branch));
	if (value !== null && typeof value === "object") {
		if ("in" in value) return value.in.includes(row[key]);
		if ("some" in value) return Array.isArray(row[key]) && row[key].some((item: Row) => matches(item, value.some));
		return matches(row[key], value);
	}
	return row[key] === value;
});

async function run() {
	const previous = new Map<string, NodeModule | undefined>();
	const isolate = (path: string, exports: unknown) => {
		const id = require.resolve(path); if (!previous.has(id)) previous.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
	};
	const stub = (path: string, value: unknown) => isolate(path, { __esModule: true, default: value });
	const fresh = (path: string) => {
		const id = require.resolve(path); if (!previous.has(id)) previous.set(id, require.cache[id]);
		delete require.cache[id]; return require(path);
	};
	const session = (userId = 6, override: Partial<SessionData> = {}): SessionData => ({ instance: "odim", userId, sectorId: 138, role: "ADMIN", name: "Test", ...override });
	const chat = (id: number, userId: number, extra: Row = {}): Row => ({ id, instance: "odim", userId, sectorId: 138, isFinished: false, wallet: null,
		contactId: id + 100, contact: { id: id + 100, customerId: null }, ...extra });
	const chats = [chat(1, 6), chat(2, 9), chat(3, 9, { sectorId: 139 }), chat(4, 510), chat(5, 9, { instance: "foreign" }), chat(6, 9, { isFinished: true })];
	const events: Row[] = [], preferences: Row[] = [], observerReads: Row[] = [];
	let observer = { NIVEL: "ADMIN", ATIVO: "SIM", SETOR: 138 };
	let observerError = false;
	const messageRows = [{ id: 99, instance: "odim", chatId: 2, contactId: 102 }];
	const db: Row = {
		wppChat: {
			findMany: async ({ where }: Row) => chats.filter((row) => matches(row, where)).map((row) => ({ ...row })),
			findFirst: async ({ where }: Row) => { const row = chats.find(c => matches(c, where)); return row ? { ...row } : null; },
			updateMany: async ({ where, data }: Row) => { const row = chats.find(c => matches(c, where)); if (row) Object.assign(row, data); return { count: row ? 1 : 0 }; },
			findUnique: async ({ where }: Row) => { const row = chats.find((row) => matches(row, where)); return row ? { ...row } : null; },
			update: async ({ where, data }: Row) => { const row = chats.find((row) => matches(row, where))!; Object.assign(row, data); return { ...row }; },
		},
		wppMessage: { findMany: async ({ where }: Row) => messageRows.filter((row) => matches(row, where)), groupBy: async () => [] },
		chatUserPreference: {
			findMany: async () => [], findUnique: async () => null, count: async () => 0,
			upsert: async ({ create }: Row) => { preferences.push(create); return create; },
		},
		$transaction: async (callback: (tx: Row) => unknown) => callback(db),
	};
	class SilentLogger { log() {} success() {} failed() {} }
	let distribution: Row;
	const distributionProxy = { notifyAssignedOperator: () => undefined, addSystemMessage: async () => undefined };
	try {
		isolate("@in.pulse-crm/utils", { Logger: { info() {}, error() {}, debug() {} }, sanitizeErrorMessage: String });
		stub("../utils/processing-logger", SilentLogger);
		stub("./prisma.service", db);
		stub("./wallets.service", { getUserWallets: async () => [], effectiveWallets: async () => [], assertChatMember: async () => {} });
		stub("./manual-chat-authorization.service", { isEnabled: async () => false });
		stub("./instances.service", { executeQuery: async (instance: string, query: string, values: number[]) => {
			assert.equal(instance, "odim"); assert.equal(query, "SELECT CODIGO, NIVEL, ATIVO, SETOR FROM operadores WHERE CODIGO = ? LIMIT 1");
			observerReads.push({ values }); if (observerError) throw Error("offline"); return [{ CODIGO: values[0], ...observer }];
		} });
		stub("./parameters.service", { getSessionParams: async () => ({}) });
		stub("./message-presentation.service", { hydrate: async (_instance: string, rows: Row[]) => rows });
		stub("./socket.service", { emit: async (event: string, room: string, data: Row) => { events.push({ event, room, data }); } });
		stub("./users.service", () => ({ setAuth() {}, getUserById: async (id: number) => ({ CODIGO: id, NOME: "Test" }) }));
		stub("./transfer-history.service", { recordTransfer: async () => undefined });
		stub("./messages-distribution.service", distributionProxy);
		for (const path of ["./whatsapp.service", "./contacts.service", "./public-report-fields.service", "../bots/exatron-satisfaction.bot"])
			stub(path, {});
		const preferenceService = fresh("./chat-user-preferences.service").default;
		preferenceService.withUnreadAssignment = (write: (tx: Row) => unknown) => write(db);
		const chatService = fresh("./chats.service").default;
		chatService.syncChatToLocal = async () => undefined;
		const { previousChatAccess, SessionChangeRepository } = fresh("./session-changes/session-change.repository");

		assert.equal(odimSupervisionPeer(session(6)), 9); assert.equal(odimSupervisionPeer(session(9)), 6);
		assert.equal(odimSupervisionPeer(session(6, { instance: "ÓDIM" })), 9);
		const oldScope = (scope: SessionData) => createHash("sha256").update(JSON.stringify([scope.instance, scope.userId, scope.sectorId, scope.role, []])).digest("hex");
		assert.equal(decodeCursor(encodeCursor(oldScope(session()), "epoch", "4"), cursorScope(session(), [])), null,
			"existing supervisor cursors must request a fresh snapshot that includes the peer's older chats");
		for (const unaffected of [session(510), session(6, { instance: "foreign" }), session(6, { role: "ATIVO" })])
			assert.equal(cursorScope(unaffected, []), oldScope(unaffected), "unaffected cursor hashes remain byte-identical");
		for (const invalid of [session(510), session(6, { instance: "foreign" }), session(6, { role: "ATIVO" }), session(6, { sectorId: 0 })])
			assert.equal(odimSupervisionPeer(invalid), null);
		for (const userId of [6, 9]) {
			const snapshot = await chatService.getUserChatsBySession(session(userId), false, false);
			assert.deepEqual(snapshot.chats.map((row: Row) => row["id"]).sort(), userId === 6 ? [1, 2] : [1, 2, 3],
				"each supervisor gains the peer's current-sector chats and preserves existing access to their own chats");
			await preferenceService.update(session(userId), "wpp", userId === 6 ? 2 : 1, "pin");
		}
		assert.deepEqual(preferences.map((row) => row["userId"]), [6, 9], "pin/unread preferences stay personal");
		for (const invalid of [session(6, { role: "ATIVO" }), session(6, { sectorId: 139 }), session(510)]) {
			await assert.rejects(preferenceService.update(invalid, "wpp", 2, "pin"));
		}
		assert.deepEqual((await chatService.getUserChatsBySession(session(6, { role: "ATIVO" }), false, false)).chats.map((row: Row) => row["id"]), [1]);
		assert.deepEqual((await chatService.getUserChatsBySession(session(6, { instance: "foreign" }), false, false)).chats, []);
		assert.deepEqual((await chatService.getUserChatsBySession(session(), false, false, [2, 5])).chats.map((row: Row) => row["id"]), [2], "filtered incremental snapshot preserves scope");

		const change = (extra: Row = {}): JournalRow => ({ sequence: "1", kind: "message", entityId: 99, chatId: 2, previousUserId: 9, previousSectorId: 138, previousWalletId: null, ...extra });
		assert(previousChatAccess(session(), change(), []));
		assert(!previousChatAccess(session(), change({ previousSectorId: 139 }), []));
		assert(!previousChatAccess(session(6, { role: "ATIVO" }), change(), []));
		const repo = new SessionChangeRepository();
		const update = await repo.project(session(), [change()], []);
		assert.deepEqual(update.chats.map((row: Row) => row["id"]), [2]); assert.deepEqual(update.messages.map((row: Row) => row["id"]), [99]);
		chats[1]!["userId"] = 510;
		const removal = await repo.project(session(), [change({ kind: "chat", entityId: 2 })], []);
		assert.deepEqual(removal.removedChatIds, [2]); chats[1]!["userId"] = 9;

		assert(keepsOdimSupervisionAccess(chat(1, 6) as any, chat(1, 9) as any));
		assert(!keepsOdimSupervisionAccess(chat(1, 6) as any, chat(1, 510) as any));
		assert(!keepsOdimSupervisionAccess(chat(1, 6) as any, chat(1, 9, { sectorId: 139 }) as any));
		await chatService.transferAttendance("test", session(), 1, 9);
		assert(!events.some((row) => row["event"] === "wpp_chat_transfer"), "6 to 9 must keep the shared chat open");
		assert(events.some((row) => row["event"] === "wpp_chat_started" && row["room"] === "odim:user:6"));
		assert(events.some((row) => row["event"] === "wpp_chat_started" && row["room"] === "odim:user:9"));
		events.length = 0;
		await chatService.transferAttendance("test", session(), 1, 510);
		assert(events.some((row) => row["event"] === "wpp_chat_transfer" && row["room"] === "odim:chat:1"), "leaving the pair removes the shared chat");
		assert(!events.some((row) => row["event"] === "wpp_chat_started" && ["odim:user:6", "odim:user:9"].includes(row["room"])));

		for (const path of ["../message-flow/message-flow", "../message-flow/message-flow.factory", "../bots/bots-registry", "./message-queue.service", "./messages.service", "./message-mentions.service"])
			stub(path, {});
		stub("./message-queue.service", { setProcessHandler() {} });
		distribution = fresh("./messages-distribution.service").default;
		distribution["sendPushNotification"] = async () => undefined;
		events.length = 0;
		await distribution["notifyChatStarted"](new SilentLogger(), chat(2, 9));
		assert.deepEqual(events.filter((row) => row["room"].includes(":user:")).map((row) => row["room"]).sort(), ["odim:user:6", "odim:user:9"]);
		for (const invalid of [{ NIVEL: "ATIVO", ATIVO: "SIM", SETOR: 138 }, { NIVEL: "ADMIN", ATIVO: "NAO", SETOR: 138 }, { NIVEL: "ADMIN", ATIVO: "SIM", SETOR: 139 }]) {
			observer = invalid; events.length = 0;
			await distribution["notifyChatStarted"](new SilentLogger(), chat(2, 9));
			assert(!events.some((row) => row["room"] === "odim:user:6"));
		}
		observerError = true; events.length = 0;
		await distribution["notifyChatStarted"](new SilentLogger(), chat(2, 9));
		assert(events.some((row) => row["room"] === "odim:user:9")); assert(!events.some((row) => row["room"] === "odim:user:6"));
		const before = observerReads.length;
		await distribution["notifyChatStarted"](new SilentLogger(), chat(2, 9, { instance: "foreign" }));
		assert.equal(observerReads.length, before, "other tenants never query the Odim observer rule");
		console.log("odim-supervision-sharing: real snapshot/preferences/journal/transfer/new-chat paths pass; tenant, role, sector, deactivation and CRM-failure boundaries pass");
	} finally {
		for (const [id, cached] of previous) { if (cached) require.cache[id] = cached; else delete require.cache[id]; }
	}
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
