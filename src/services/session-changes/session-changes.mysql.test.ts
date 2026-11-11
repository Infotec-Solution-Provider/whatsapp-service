import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import mysql, { RowDataPacket } from "mysql2/promise";
import { SessionChangeReader } from "./session-change-reader";
import type { SessionData } from "../../sdk-local";

// Fixed loopback/port and a fresh database: this suite cannot target an application DB.
test("journal migration, atomic publication, late linkage, authorization and retention on MySQL 8", { timeout: 120000 }, async () => {
	const database = `session_changes_test_${process.pid}_${Date.now()}`;
	const config = { host: "127.0.0.1", port: 13328, user: "root", multipleStatements: true };
	const admin = await mysql.createConnection(config);
	await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
	const db = await mysql.createConnection({ ...config, database });
	const a = await mysql.createConnection({ ...config, database });
	const b = await mysql.createConnection({ ...config, database });
	let disconnect = async () => {};
	try {
		const ddl = execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "diff", "--from-empty",
			"--to-schema-datamodel", resolve("prisma/schema.prisma"), "--script"], { encoding: "utf8" });
		await db.query(ddl);
		// Exercise the migration itself against an existing schema, rather than approximating its triggers.
		await db.query("DROP TABLE session_changes, session_change_streams");
		await db.query(readFileSync(resolve("prisma/migrations/20261022120000_session_changes/migration.sql"), "utf8"));
		const [triggers] = await db.query<RowDataPacket[]>("SELECT COUNT(*) total FROM information_schema.triggers WHERE trigger_schema=?", [database]);
		assert.equal(triggers[0]?.["total"], 9);
		await db.query("INSERT INTO contacts (id,instance,name,phone) VALUES (10,'alpha','Contact A','100'),(20,'beta','Contact B','200')");
		await db.query("INSERT INTO chats (id,instance,contact_id,user_id,type) VALUES (1,'alpha',10,2,'RECEPTIVE'),(2,'beta',20,2,'RECEPTIVE')");
		process.env["WHATSAPP_DATABASE_URL"] = `mysql://root@127.0.0.1:13328/${database}`;
		const { SessionChangeRepository } = require("./session-change.repository") as typeof import("./session-change.repository");
		const { default: prisma } = require("../prisma.service") as typeof import("../prisma.service");
		disconnect = () => prisma.$disconnect();
		const { pruneSessionChanges } = require("./session-change-retention") as typeof import("./session-change-retention");
		const repo = new SessionChangeRepository();
		const reader = new SessionChangeReader(repo);
		const session: SessionData = { instance: "alpha", userId: 2, sectorId: 135, role: "RECEP", name: "Operator" };
		type Changes = { chats: Array<{ id: number }>; messages: Array<{ id: number; body: string }>; removedChatIds: number[]; removedMessageIds: number[] };
		let cursor = await reader.capture(session);
		const insert = (id: number, chat: number | null) => db.query(
			"INSERT INTO messages (id,instance,contact_id,chat_id,`from`,`to`,type,body,timestamp,sent_at,status) VALUES (?,'alpha',10,?,'customer','me:7','text','body','1000','2020-01-01','RECEIVED')", [id, chat]);
		await insert(10, null);
		await insert(11, 1);
		let page = await reader.read(session, cursor, 100);
		assert.deepEqual((page.changes as Changes).messages.map((m) => m.id), [11]);
		cursor = page.nextCursor!;
		await db.query("UPDATE messages SET chat_id=1 WHERE id=10");
		page = await reader.read(session, cursor, 100);
		assert.deepEqual((page.changes as Changes).messages.map((m) => m.id), [10], "older message ID linked after the cursor must be recovered");
		cursor = page.nextCursor!;
		await a.beginTransaction();
		await a.query("UPDATE messages SET body='rolled back' WHERE id=10");
		assert.equal((await reader.read(session, cursor, 100)).hasMore, false);
		assert.equal((await repo.read("alpha", null, 0)).head.sequence, JSON.parse(Buffer.from(cursor, "base64url").toString()).sequence);
		await a.rollback();
		assert.equal((await reader.read(session, cursor, 100)).changes && ((await reader.read(session, cursor, 100)).changes as Changes).messages.length, 0);

		await a.beginTransaction();
		await b.beginTransaction();
		await a.query("UPDATE messages SET body='commit A' WHERE id=10");
		let finishedB = false;
		const writeB = b.query("UPDATE messages SET body='commit B' WHERE id=11").then(() => { finishedB = true; });
		await new Promise((done) => setTimeout(done, 50));
		assert.equal(finishedB, false, "same-instance publication waits for the preceding commit");
		assert.equal(((await reader.read(session, cursor, 100)).changes as Changes).messages.length, 0);
		await a.commit();
		await writeB;
		page = await reader.read(session, cursor, 1);
		assert.deepEqual((page.changes as Changes).messages.map((m) => m.body), ["commit A"]);
		cursor = page.nextCursor!;
		await b.commit();
		page = await reader.read(session, cursor, 1);
		assert.deepEqual((page.changes as Changes).messages.map((m) => m.body), ["commit B"]);
		cursor = page.nextCursor!;
		await db.query("UPDATE chats SET user_id=3 WHERE id=1");
		page = await reader.read(session, cursor, 100);
		assert.deepEqual((page.changes as Changes).removedChatIds, [1]);
		assert.equal((page.changes as Changes).messages.length, 0);
		assert.equal((page.changes as Changes).chats.length, 0);
		const other = { ...session, userId: 3 };
		assert.equal((await reader.read(other, cursor, 100)).resetRequired, true, "cursor belongs to the authenticated scope");
		const otherCursor = await reader.capture(other);
		await db.query("UPDATE messages SET body='new owner' WHERE id=10");
		assert.deepEqual(((await reader.read(other, otherCursor, 100)).changes as Changes).messages.map((m) => m.body), ["new owner"]);
		assert.equal(((await reader.read(session, cursor, 100)).changes as Changes).messages.length, 0);
		await db.query("INSERT INTO wallets (id,instance,name) VALUES (1,'alpha','shared'); INSERT INTO wallets_users (wallet_id,user_id) VALUES (1,2); UPDATE chats SET wallet_id=1 WHERE id=1");
		assert.equal((await reader.read(session, cursor, 100)).resetRequired, true, "wallet membership change requires a new snapshot");
		cursor = await reader.capture(session);
		await db.query("UPDATE messages SET status='READ' WHERE id=10");
		assert.deepEqual(((await reader.read(session, cursor, 100)).changes as Changes).messages.map((m) => m.id), [10]);
		cursor = (await reader.read(session, cursor, 100)).nextCursor!;
		await db.query("DELETE FROM messages WHERE id=10");
		assert.deepEqual(((await reader.read(session, cursor, 100)).changes as Changes).removedMessageIds, [10]);
		// A beta event is never returned by the alpha stream.
		await db.query("UPDATE chats SET user_id=8 WHERE id=2");
		assert.deepEqual(((await reader.read(session, cursor, 100)).changes as Changes).removedChatIds, []);
		// Numeric ordering must stay correct past sequence 9 (the API serializes BIGINT as strings).
		for (let i = 0; i < 25; i++) await db.query("UPDATE messages SET body=? WHERE id=11", [`version ${i}`]);
		let after = "0";
		for (let i = 0; i < 100; i++) {
			const batch = await repo.read("alpha", after, 3);
			if (!batch.rows.length) break;
			for (const row of batch.rows) {
				assert.equal(BigInt(row.sequence), BigInt(after) + 1n, "paging is numerically ordered and has no publication gaps");
				after = row.sequence;
			}
		}
		assert.equal(after, (await repo.read("alpha", null, 0)).head.sequence);
		await db.query("INSERT INTO chats (id,instance,contact_id,user_id,type) VALUES (4,'alpha',10,2,'RECEPTIVE')");
		cursor = await reader.capture(session);
		await db.query("UPDATE messages SET chat_id=4 WHERE id=11");
		page = await reader.read(session, cursor, 100);
		assert.deepEqual((page.changes as Changes).chats.map((chat) => chat.id).sort(), [1, 4], "moving a message refreshes both conversations");
		await db.query("INSERT INTO sectors(id,instance,name,start_chats,receive_chats) VALUES (135,'alpha','alpha',1,1); INSERT INTO chats (id,instance,contact_id,user_id,sector_id,type) VALUES (5,'alpha',10,-1,135,'RECEPTIVE')");
		const supervisor = { ...session, role: "ADMIN" };
		const adminCursor = await reader.capture(supervisor);
		const userCursor = await reader.capture(session);
		await insert(12, 5);
		assert.equal(((await reader.read(supervisor, adminCursor, 100)).changes as Changes).messages.length, 1);
		assert.equal(((await reader.read(session, userCursor, 100)).changes as Changes).messages.length, 0);
		cursor = await reader.capture(session);
		await db.query("INSERT INTO chat_user_preferences (instance,user_id,chat_type,chat_id,is_pinned,is_marked_unread,updated_at) VALUES ('alpha',2,'wpp',4,1,1,UTC_TIMESTAMP())");
		page = await reader.read(session, cursor, 100);
		assert.ok((page.changes as { chats: Array<{ id: number; isPinned: boolean; isUnread: boolean }> }).chats.some((chat) => chat.id === 4 && chat.isPinned && chat.isUnread));
		// Arrival remains personal after all customer messages have already been read.
		const { default: preferences } = require("../chat-user-preferences.service") as typeof import("../chat-user-preferences.service");
		const { default: chatsService } = require("../chats.service") as typeof import("../chats.service");
		await db.query("UPDATE messages SET status='READ' WHERE instance='alpha'");
		const recipientCursor = await reader.capture(other);
		await preferences.withUnreadAssignment((tx) => tx.wppChat.update({ where: { id: 4 }, data: { userId: 3 } }));
		const received = await reader.read(other, recipientCursor, 100);
		assert.ok((received.changes as { chats: Array<{ id: number; isUnread: boolean }> }).chats.some((chat) => chat.id === 4 && chat.isUnread));
		for (let replay = 0; replay < 3; replay++) {
			assert.equal((await chatsService.getUserChatsBySession(other, false, true, [4])).chats[0]?.isUnread, true);
		}
		await preferences.markRead(session, "wpp", 4);
		assert.equal((await chatsService.getUserChatsBySession(other, false, true, [4])).chats[0]?.isUnread, true, "previous attendant cannot acknowledge recipient arrival");
		await preferences.markRead(other, "wpp", 4);
		assert.equal((await chatsService.getUserChatsBySession(other, false, true, [4])).chats[0]?.isUnread, false);
		const rollbackHead = (await repo.read("alpha", null, 0)).head.sequence;
		await assert.rejects(preferences.withUnreadAssignment(async (tx) => ({
			...await tx.wppChat.update({ where: { id: 4 }, data: { userId: 7 } }),
			userId: 2147483648 // Force a real Prisma/MySQL preference failure after the chat update.
		})));
		assert.equal((await prisma.wppChat.findUnique({ where: { id: 4 } }))?.userId, 3);
		assert.equal((await repo.read("alpha", null, 0)).head.sequence, rollbackHead, "failed preference must roll back assignment and journal");
		cursor = await reader.capture(session);
		const durations: number[] = [];
		for (let i = 0; i < 30; i++) {
			const started = performance.now();
			const emptyPage = await reader.read(session, cursor, 100);
			assert.equal((emptyPage.changes as Changes).messages.length, 0);
			durations.push(performance.now() - started);
		}
		durations.sort((x, y) => x - y);
		console.log(`Local empty delta (30 sequential reads): median=${durations[15]!.toFixed(1)}ms p95=${durations[28]!.toFixed(1)}ms; excludes HTTP/auth/tenant network`);
		const [indexedPlan] = await db.query<RowDataPacket[]>("EXPLAIN SELECT sequence FROM session_changes WHERE instance='alpha' AND sequence>1 AND sequence<=100 ORDER BY sequence LIMIT 101");
		assert.equal(indexedPlan[0]?.["key"], "PRIMARY");
		assert.equal(indexedPlan[0]?.["type"], "range");
		// Leave the cursor behind an additional event before expiring the entire prefix.
		await db.query("UPDATE messages SET body='after cursor' WHERE id=11");
		await db.query("UPDATE session_changes SET created_at=UTC_TIMESTAMP()-INTERVAL 8 DAY WHERE instance='alpha'");
		assert.ok(await pruneSessionChanges("alpha") > 0);
		assert.equal((await reader.read(session, cursor, 100)).resetRequired, true);
		const [plan] = await db.query<RowDataPacket[]>("EXPLAIN SELECT sequence FROM session_changes WHERE instance='alpha' AND sequence>1 AND sequence<=100 ORDER BY sequence LIMIT 101");
		assert.ok(plan[0]?.["key"] === "PRIMARY" || plan[0]?.["rows"] <= 1);
		console.log("MySQL: migration, rollback, concurrent commit order, late linkage, ownership, wallet reset, delete, tenant isolation, retention and EXPLAIN passed");
	} finally {
		await a.rollback(); await b.rollback();
		await disconnect();
		await a.end(); await b.end(); await db.end();
		await admin.query(`DROP DATABASE ${database}`);
		await admin.end();
	}
});
