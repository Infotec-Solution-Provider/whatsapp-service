import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createPool } from "mysql2/promise";
import { createNativeTenantClient } from "../tenant-sql/engine";
import { OperatorPauseAdmission, pauseAdmissionFailure, type ChatAssignmentAdmission } from "./operator-pause-admission";

const ports = [13555, 13480];
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 40));
for (const port of ports) test(`native CRM admission MySQL ${port}: rollback, unchanged ownership and concurrent pause`, async () => {
	const name = `operator_pause_assignment_${Date.now()}_${randomBytes(3).toString("hex")}`;
	const admin = createPool({ host: "127.0.0.1", port, user: "root", connectionLimit: 1 });
	await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
	const pool = createPool({ host: "127.0.0.1", port, user: "root", database: name, connectionLimit: 4, timezone: "Z" });
	const client = createNativeTenantClient("fixture", pool), gate = new OperatorPauseAdmission();
	const scope = (recipientId: number, chatId?: number): ChatAssignmentAdmission => ({ instance: "fixture", recipientId, ...(chatId === undefined ? {} : { chatId }) });
	const assign = (id: number, admission = scope(7), fail = false) => client.$transaction(async tx => {
		await gate.assert(tx, admission, true);
		await tx.$executeRawUnsafe("INSERT INTO chats(id,instance,user_id,started_at) VALUES(?,?,?,UTC_TIMESTAMP())", id, "fixture", admission.recipientId);
		if (fail) throw new Error("preference failed");
	});
	try {
		await pool.query("CREATE TABLE telephony_runtime_policy(id INT PRIMARY KEY,enabled TINYINT,pause_all_channels TINYINT,preflight_hash CHAR(64)) ENGINE=InnoDB");
		await pool.query("CREATE TABLE telephony_operator_state(operator_id INT PRIMARY KEY,state VARCHAR(20) NOT NULL DEFAULT 'available',version INT NOT NULL DEFAULT 0,unavailable_since DATETIME NULL) ENGINE=InnoDB");
		await pool.query("CREATE TABLE operadores(CODIGO INT PRIMARY KEY,ATIVO VARCHAR(3)) ENGINE=InnoDB");
		await pool.query("CREATE TABLE wpp_runtime_chats(id INT PRIMARY KEY,instance VARCHAR(30),contact_id INT NOT NULL DEFAULT 1,user_id INT NULL,is_finished TINYINT NOT NULL DEFAULT 0,is_schedule TINYINT NOT NULL DEFAULT 0,started_at DATETIME NULL) ENGINE=InnoDB");
		await pool.query("CREATE TABLE wpp_runtime_contacts(id INT PRIMARY KEY,instance VARCHAR(30),phone VARCHAR(100),whatsapp_id VARCHAR(100)) ENGINE=InnoDB");
		await pool.query("INSERT INTO wpp_runtime_contacts VALUES(1,'fixture','5551999999999','5551999999999')");
		await pool.query("CREATE TABLE wpp_runtime_messages(id INT PRIMARY KEY,chat_id INT NULL,body TEXT) ENGINE=InnoDB");
		await pool.query("INSERT INTO telephony_runtime_policy VALUES(1,1,1,?)", ["a".repeat(64)]);
		await pool.query("INSERT INTO operadores VALUES(7,'SIM'),(8,'SIM'),(9,'NAO')");
		await pool.query("INSERT INTO telephony_operator_state(operator_id,state,version) VALUES(7,'paused',1),(8,'available',0)");
		for (const state of ["paused", "pending"]) {
			await pool.query("UPDATE telephony_operator_state SET state=? WHERE operator_id=7", [state]);
			await assert.rejects(assign(1), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
		}
		await assert.rejects(assign(1, { instance: "fixture", recipientId: -1, initiatorId: 7 }), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
		await assert.rejects(assign(1, scope(9)), error => pauseAdmissionFailure(error)?.code === "OPERATOR_AVAILABILITY_UNAVAILABLE");
		await assert.rejects(assign(1, scope(8), true), /preference failed/);
		assert.equal((await pool.query<any[]>("SELECT * FROM wpp_runtime_chats"))[0].length, 0);
		assert.equal((await pool.query<any[]>("SELECT * FROM telephony_operator_state WHERE operator_id=9"))[0].length, 0, "failed admission rolls back its state upsert");

		// An admission owning the operator lock commits before a pause can be acknowledged.
		await pool.query("UPDATE telephony_operator_state SET state='available' WHERE operator_id=7");
		const admitted = barrier(), finishAssignment = barrier(); let pauseAcquired = false;
		const writing = client.$transaction(async tx => {
			await gate.assert(tx, scope(7), true);
			await tx.$executeRawUnsafe("INSERT INTO chats(id,instance,user_id,started_at) VALUES(1,'fixture',7,UTC_TIMESTAMP())");
			admitted.release(); await finishAssignment.promise;
		});
		await admitted.promise;
		const pause = (async () => { const c = await pool.getConnection(); try {
			await c.beginTransaction(); await c.query("SELECT operator_id FROM telephony_operator_state WHERE operator_id=7 FOR UPDATE");
			pauseAcquired = true; await c.query("UPDATE telephony_operator_state SET state='paused',version=version+1 WHERE operator_id=7"); await c.commit();
		} finally { c.release(); } })();
		await tick(); assert.equal(pauseAcquired, false);
		finishAssignment.release(); await writing; await pause;
		assert.equal((await pool.query<any[]>("SELECT * FROM wpp_runtime_chats WHERE id=1"))[0].length, 1);

		// Same owner remains usable; a transfer away remains possible while it is paused.
		await client.$transaction(async tx => { await gate.assert(tx, scope(7, 1), true); await tx.$executeRawUnsafe("UPDATE chats SET user_id=7 WHERE id=1"); });
		for (const change of ["is_finished=1", "is_finished=0,is_schedule=1", "is_schedule=0,started_at=NULL"]) {
			await pool.query(`UPDATE wpp_runtime_chats SET ${change} WHERE id=1`);
			await assert.rejects(client.$transaction(async tx => { await gate.assert(tx, scope(7, 1), true); await tx.$executeRawUnsafe("UPDATE chats SET is_finished=0,is_schedule=0,started_at=UTC_TIMESTAMP() WHERE id=1"); }), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
		}
		await pool.query("UPDATE wpp_runtime_chats SET is_finished=0,is_schedule=0,started_at=UTC_TIMESTAMP() WHERE id=1");
		await client.$transaction(async tx => { await gate.assert(tx, scope(8, 1), true); await tx.$executeRawUnsafe("UPDATE chats SET user_id=8 WHERE id=1"); });
		await assert.rejects(client.$transaction(async tx => { await gate.assert(tx, scope(7, 1), true); await tx.$executeRawUnsafe("UPDATE chats SET user_id=7 WHERE id=1"); }), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
		assert.equal((await pool.query<any[]>("SELECT user_id FROM wpp_runtime_chats WHERE id=1"))[0][0].user_id, 8);

		// A pause which owns the lock first fences a concurrent new assignment.
		await pool.query("UPDATE telephony_operator_state SET state='available' WHERE operator_id=7");
		const c = await pool.getConnection();
		await c.beginTransaction(); await c.query("SELECT operator_id FROM telephony_operator_state WHERE operator_id=7 FOR UPDATE");
		await c.query("UPDATE telephony_operator_state SET state='paused',version=version+1 WHERE operator_id=7");
		let assigned = false;
		const blocked = assign(2).then(() => { assigned = true; });
		const rejection = assert.rejects(blocked, error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
		await tick(); assert.equal(assigned, false); await c.commit(); c.release(); await rejection;
		assert.equal((await pool.query<any[]>("SELECT * FROM wpp_runtime_chats WHERE id=2"))[0].length, 0);
		await pool.query("UPDATE telephony_operator_state SET state='paused',unavailable_since='2026-11-16 12:00:00' WHERE operator_id=7");
		await pool.query("INSERT INTO wpp_runtime_chats(id,instance,user_id,started_at) VALUES(4,'fixture',-1,'2026-11-16 11:59:59'),(5,'fixture',NULL,'2026-11-16 12:00:00'),(6,'fixture',-1,'2026-11-16 12:00:01'),(7,'fixture',7,'2026-11-16 12:00:01')");
		const send = (chatId: number, to = "5551999999999") => client.$transaction(async tx => {
			await gate.assertSend(tx, { instance: "fixture", actorId: 7, chatId, to }, true);
			await tx.$executeRawUnsafe("INSERT INTO messages(id,chat_id,body) VALUES(?,?,'synthetic')", chatId, chatId);
		});
		await send(4); await send(7);
		await assert.rejects(send(7, "5551888888888"), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
		for (const chatId of [5, 6]) await assert.rejects(send(chatId), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
		assert.deepEqual((await pool.query<any[]>("SELECT id FROM wpp_runtime_messages ORDER BY id"))[0].map(row => row.id), [4, 7]);
		await pool.query("DROP TABLE telephony_operator_state");
		await assert.rejects(assign(3, scope(8)), error => pauseAdmissionFailure(error)?.code === "OPERATOR_AVAILABILITY_UNAVAILABLE");
	} finally {
		await pool.end(); await admin.query(`DROP DATABASE \`${name}\``); await admin.end();
	}
});
