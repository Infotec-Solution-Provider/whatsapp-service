import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPool } from "mysql2/promise";
import { PrismaClient } from "@prisma/client";
import { CentralOperatorAdmission, pauseAdmissionFailure, type ChatAssignmentAdmission } from "./central-operator-admission";
import { lockRuntimeAdmission } from "../operator-runtime/core";
import type { OperatorOutboundEnqueueInput } from "./operator-outbound.types";

const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 60));
test("central MySQL8 Prisma: tenant isolation, rollback, concurrent pause, shared cutoff and durable replay", async () => {
	const name = `central_admission_${Date.now()}_${randomBytes(3).toString("hex")}`;
	const admin = createPool({ host: "127.0.0.1", port: 13480, user: "root", connectionLimit: 1 });
	await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
	const pool = createPool({ host: "127.0.0.1", port: 13480, user: "root", database: name, connectionLimit: 2, timezone: "Z" });
	const db = new PrismaClient({ datasources: { db: { url: `mysql://root@127.0.0.1:13480/${name}?connection_limit=5` } } });
	const gate = new CentralOperatorAdmission();
	const config = require("../operator-runtime/config") as { isCentralRuntimeConfigured: (instance: string) => boolean };
	const previousConfigured = config.isCentralRuntimeConfigured;
	config.isCentralRuntimeConfigured = instance => ["alpha", "beta"].includes(instance);
	// Exercise the production wrappers with this isolated Prisma client, without bootstrapping the app.
	const path = require.resolve("./prisma.service"), previous = require.cache[path];
	require.cache[path] = { id: path, filename: path, loaded: true, exports: { __esModule: true, default: db } } as NodeModule;
	const preferences = require("./chat-user-preferences.service").default as typeof import("./chat-user-preferences.service").default;
	const Repository = require("./operator-outbound.repository").default as typeof import("./operator-outbound.repository").default;
	if (previous) require.cache[path] = previous; else delete require.cache[path];
	const repository = new Repository(db);
	const scope = (recipientId: number, chatId?: number, instance = "alpha"): ChatAssignmentAdmission => ({ instance, recipientId, ...(chatId === undefined ? {} : { chatId }) });
	const assign = (id: number, input = scope(7)) => preferences.withUnreadAssignment(tx => tx.wppChat.create({
		data: { id, instance: input.instance, userId: input.recipientId ?? null, type: "RECEPTIVE", startedAt: new Date() }
	}), input);
	const paused = (error: unknown) => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED";
	const count = async (table: string) => Number((await pool.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
	try {
		for (const sql of readFileSync(join(__dirname, "../operator-runtime/schema.sql"), "utf8").replace(/^--.*$/gm, "").split(";").map(s => s.trim()).filter(Boolean)) await pool.query(sql);
		await pool.query("CREATE TABLE chats(id INT PRIMARY KEY AUTO_INCREMENT,instance VARCHAR(191),contact_id INT NULL,user_id INT NULL,wallet_id INT NULL,bot_id INT NULL,agent_id INT NULL,result_id INT NULL,sector_id INT NULL,schedule_id INT NULL,type VARCHAR(20),priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL',avatar_url TEXT NULL,is_finished TINYINT NOT NULL DEFAULT 0,started_at DATETIME(3) NULL,finished_at DATETIME(3) NULL,finished_by INT NULL,is_schedule TINYINT NOT NULL DEFAULT 0) ENGINE=InnoDB");
		await pool.query("CREATE TABLE contacts(id INT PRIMARY KEY,instance VARCHAR(191),phone VARCHAR(100),whatsapp_id VARCHAR(100)) ENGINE=InnoDB");
		await pool.query("CREATE TABLE chat_user_preferences(id INT PRIMARY KEY AUTO_INCREMENT,instance VARCHAR(191),user_id INT,chat_type VARCHAR(191),chat_id INT,is_pinned TINYINT NOT NULL DEFAULT 0,is_marked_unread TINYINT NOT NULL DEFAULT 0,created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),updated_at DATETIME(3) NOT NULL,UNIQUE KEY scope(instance,user_id,chat_type,chat_id)) ENGINE=InnoDB");
		await pool.query("CREATE TABLE messages(id INT PRIMARY KEY AUTO_INCREMENT,instance VARCHAR(191),wwebjs_id VARCHAR(191) NULL,wwebjs_id_stanza VARCHAR(191) NULL,waba_id VARCHAR(191) NULL,gupshup_id VARCHAR(191) NULL,gupshup_request_id VARCHAR(191) NULL,`from` VARCHAR(191),`to` VARCHAR(191),type VARCHAR(191),quoted_id INT NULL,chat_id INT NULL,contact_id INT NULL,is_forwarded TINYINT NOT NULL DEFAULT 0,is_edited TINYINT NOT NULL DEFAULT 0,body TEXT,mention_metadata JSON NULL,timestamp VARCHAR(191),status_timestamp VARCHAR(191) NULL,sent_at DATETIME(3),status VARCHAR(30),file_id INT NULL,file_name VARCHAR(191) NULL,file_type VARCHAR(191) NULL,file_size VARCHAR(191) NULL,user_id INT NULL,agent_id INT NULL,billing_category VARCHAR(191) NULL,client_id INT NULL) ENGINE=InnoDB");
		await pool.query("CREATE TABLE operator_outbound_send(id VARCHAR(191) PRIMARY KEY,instance VARCHAR(191),user_id INT,client_id INT,idempotency_key VARCHAR(191),payload_hash CHAR(64),payload JSON,message_id INT UNIQUE,delivery_mode VARCHAR(20),status VARCHAR(20) NOT NULL DEFAULT 'PENDING',remote_job_id VARCHAR(191) NULL,provider_outcome JSON NULL,notification_pending TINYINT NOT NULL DEFAULT 0,attempt_started_at DATETIME(3) NULL,attempt_count INT NOT NULL DEFAULT 0,next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),locked_by VARCHAR(191) NULL,locked_until DATETIME(3) NULL,error TEXT NULL,created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),updated_at DATETIME(3) NOT NULL,completed_at DATETIME(3) NULL,UNIQUE KEY scope(instance,user_id,idempotency_key)) ENGINE=InnoDB");
		await pool.query("INSERT INTO operator_runtime_policy(instance,enabled,revision,review_sha256) VALUES('alpha',1,1,?),('beta',1,2,?)", ["a".repeat(64), "b".repeat(64)]);
		await pool.query("INSERT INTO operator_runtime_state(instance,operator_id,state,version) VALUES('alpha',7,'paused',1),('alpha',8,'available',0),('beta',7,'available',0)");
		await pool.query("INSERT INTO contacts VALUES(1,'alpha','5551999999999','5551999999999'),(2,'beta','5551888888888','5551888888888')");
		for (const state of ["paused", "pending"]) {
			await pool.query("UPDATE operator_runtime_state SET state=? WHERE instance='alpha' AND operator_id=7", [state]);
			await assert.rejects(assign(1), paused);
			await assert.rejects(assign(1, { instance: "ALPHA", recipientId: -1, initiatorId: 7 }), paused);
		}
		await assign(2, scope(7, undefined, "BeTa"));
		assert.equal(await count("chats"), 1, "same actor ID on another tenant has independent eligibility");
		await assert.rejects(assign(1, scope(7, 2)), e => pauseAdmissionFailure(e)?.status === 503);
		await assert.rejects(assign(1, scope(8, undefined, "alpha/../beta")), e => pauseAdmissionFailure(e)?.status === 503);

		// An actual preference failure rolls back the chat and the state upsert together.
		await pool.query("ALTER TABLE chat_user_preferences ADD CONSTRAINT reject_unread CHECK(user_id<>10 OR is_marked_unread=0)");
		await assert.rejects(assign(3, scope(10)));
		await pool.query("ALTER TABLE chat_user_preferences DROP CHECK reject_unread");
		assert.equal(await count("chats"), 1);
		assert.equal(Number((await pool.query<any[]>("SELECT COUNT(*) n FROM operator_runtime_state WHERE instance='alpha' AND operator_id=10"))[0][0].n), 0);

		// A new attendance holding the operator lock commits before pause can be acknowledged.
		await pool.query("UPDATE operator_runtime_state SET state='available' WHERE instance='alpha' AND operator_id=7");
		const admitted = barrier(), finishAssignment = barrier(); let pauseAcquired = false;
		const writing = preferences.withUnreadAssignment(async tx => {
			const chat = await tx.wppChat.create({ data: { id: 4, instance: "alpha", userId: 7, type: "RECEPTIVE", startedAt: new Date() } });
			admitted.release(); await finishAssignment.promise; return chat;
		}, scope(7));
		await admitted.promise;
		const pausing = db.$transaction(async tx => {
			await lockRuntimeAdmission(tx, "alpha", [7]); pauseAcquired = true;
			await tx.$executeRawUnsafe("UPDATE operator_runtime_state SET state='paused',version=version+1,unavailable_since=UTC_TIMESTAMP(3) WHERE instance='alpha' AND operator_id=7");
		});
		await tick(); assert.equal(pauseAcquired, false); finishAssignment.release(); await writing; await pausing;
		assert.equal(Number((await pool.query<any[]>("SELECT is_marked_unread n FROM chat_user_preferences WHERE chat_id=4"))[0][0].n), 1);
		await db.$transaction(async tx => { await gate.assert(tx, scope(7, 4)); await tx.wppChat.update({ where: { id: 4 }, data: { userId: 7 } }); });
		for (const change of ["is_finished=1", "is_finished=0,is_schedule=1", "is_schedule=0,started_at=NULL"]) {
			await pool.query(`UPDATE chats SET ${change} WHERE id=4`);
			await assert.rejects(db.$transaction(async tx => { await gate.assert(tx, scope(7, 4)); await tx.wppChat.update({ where: { id: 4 }, data: { isFinished: false, isSchedule: false, startedAt: new Date() } }); }), paused);
		}
		await pool.query("UPDATE chats SET is_finished=0,is_schedule=0,started_at=UTC_TIMESTAMP(3) WHERE id=4");
		await preferences.withUnreadAssignment(tx => tx.wppChat.update({ where: { id: 4 }, data: { userId: 8 } }), scope(8, 4));

		// If pause commits first, a waiting assignment observes it and creates no row.
		await pool.query("UPDATE operator_runtime_state SET state='available' WHERE instance='alpha' AND operator_id=7");
		const c = await pool.getConnection(); await c.beginTransaction();
		await c.query("SELECT operator_id FROM operator_runtime_state WHERE instance='alpha' AND operator_id=7 FOR UPDATE");
		await c.query("UPDATE operator_runtime_state SET state='paused',version=version+1 WHERE instance='alpha' AND operator_id=7");
		let assigned = false;
		const blocked = assign(5).then(() => { assigned = true; }); const rejection = assert.rejects(blocked, paused);
		await tick(); assert.equal(assigned, false); await c.commit(); c.release(); await rejection;
		assert.equal(Number((await pool.query<any[]>("SELECT COUNT(*) n FROM chats WHERE id=5"))[0][0].n), 0);

		await pool.query("UPDATE operator_runtime_state SET state='paused',unavailable_since='2026-11-16 12:00:00.123' WHERE instance='alpha' AND operator_id=7");
		await pool.query("INSERT INTO chats(id,instance,contact_id,user_id,type,started_at) VALUES(6,'alpha',1,-1,'RECEPTIVE','2026-11-16 12:00:00.122'),(7,'alpha',1,NULL,'RECEPTIVE','2026-11-16 12:00:00.123'),(8,'alpha',1,-1,'RECEPTIVE','2026-11-16 12:00:00.124'),(9,'alpha',1,7,'RECEPTIVE','2026-11-16 12:00:00.124')");
		const send = (chatId: number, to = "5551999999999", instance = "alpha") => db.$transaction(async tx => {
			await gate.assertSend(tx, { instance, actorId: 7, chatId, to });
			await tx.$executeRawUnsafe("INSERT INTO messages(instance,chat_id,body) VALUES(?,?,'synthetic')", instance, chatId);
		});
		await send(6); await send(9);
		for (const id of [7, 8]) await assert.rejects(send(id), paused);
		await assert.rejects(send(9, "5551888888888"), paused);
		await assert.rejects(send(2, "5551888888888"), paused);
		assert.equal(await count("messages"), 2);

		// Production nested message+job create is guarded; accepted UNKNOWN replays remain untouched.
		const input: OperatorOutboundEnqueueInput = { instance: "alpha", userId: 8, clientId: 9, idempotencyKey: "same-intent", payloadHash: "a".repeat(64), deliveryMode: "DIRECT", payload: {},
			message: { instance: "alpha", from: "me:synthetic", to: "5551999999999", type: "chat", body: "synthetic", timestamp: "1", sentAt: new Date(), status: "PENDING" } };
		assert.equal((await repository.enqueue(input)).created, true);
		await pool.query("UPDATE operator_outbound_send SET status='UNKNOWN'");
		await pool.query("UPDATE operator_runtime_state SET state='paused',unavailable_since=UTC_TIMESTAMP(3) WHERE instance='alpha' AND operator_id=8");
		assert.equal((await repository.enqueue(input)).job.status, "UNKNOWN");
		assert.equal((await repository.enqueue(input)).created, false);
		await assert.rejects(repository.enqueue({ ...input, idempotencyKey: "new-intent" }), paused);
		assert.equal(await count("operator_outbound_send"), 1); assert.equal(await count("messages"), 3);
		await pool.query("UPDATE operator_runtime_state SET state='available' WHERE instance='alpha' AND operator_id=8");
		await pool.query("ALTER TABLE operator_outbound_send ADD CONSTRAINT reject_job CHECK(idempotency_key <> 'reject')");
		await assert.rejects(repository.enqueue({ ...input, idempotencyKey: "reject" }));
		assert.equal(await count("operator_outbound_send"), 1); assert.equal(await count("messages"), 3);
		await assign(12, scope(7, undefined, "gamma")); // Unlisted tenant with no policy retains legacy behavior.
		config.isCentralRuntimeConfigured = () => false;
		await assert.rejects(assign(13, scope(8, undefined, "ALPHA")), error => pauseAdmissionFailure(error)?.status === 503);
		config.isCentralRuntimeConfigured = instance => ["alpha", "beta"].includes(instance);
		await pool.query("DROP TABLE operator_runtime_state");
		await assert.rejects(assign(11, scope(8)), error => pauseAdmissionFailure(error)?.status === 503);
	} finally {
		config.isCentralRuntimeConfigured = previousConfigured;
		await db.$disconnect(); await pool.end(); await admin.query(`DROP DATABASE \`${name}\``); await admin.end();
	}
});
