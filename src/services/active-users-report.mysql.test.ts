import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { rewriteRawSql } from "../tenant-sql/compiler";
import { ACTIVE_USERS_SQL, combineUserActivity, INTERNAL_ACTIVITY_SQL, threeMonthsBefore } from "./active-users-report.service";

async function main() {
	assert.equal(threeMonthsBefore(new Date("2026-05-31T10:15:00Z")).toISOString(), "2026-02-28T10:15:00.000Z");
	assert.equal(threeMonthsBefore(new Date("2024-05-31T10:15:00Z")).toISOString(), "2024-02-29T10:15:00.000Z");
	const port = execFileSync("docker", ["port", "infotec-active-users-test-20261126", "3306/tcp"], { encoding: "utf8" }).trim().split(":").pop();
	const db = await createConnection({ host: "127.0.0.1", port: Number(port), user: "root", timezone: "Z" });
	try {
		await db.query("CREATE DATABASE activity_test");
		await db.changeUser({ database: "activity_test" });
		for (const table of ["messages", "wpp_runtime_messages"]) {
			await db.query(`CREATE TABLE ${table} (instance VARCHAR(40), sent_at DATETIME(3), \`from\` VARCHAR(100), user_id INT, agent_id INT, billing_category VARCHAR(100), status VARCHAR(20), type VARCHAR(40), INDEX(instance, sent_at))`);
			await db.query(`INSERT INTO ${table} VALUES
				('a','2026-08-26 12:00:00','me:1',10,NULL,NULL,'SENT','chat'),
				('a','2026-11-26 12:00:00','user:11',NULL,NULL,NULL,'READ','audio'),
				('a','2026-11-25 12:00:00','me:1',10,NULL,NULL,'RECEIVED','chat'),
				('a','2026-08-26 11:59:59','me:1',12,NULL,NULL,'SENT','chat'),
				('a','2026-11-25 12:00:00','123',13,NULL,NULL,'RECEIVED','chat'),
				('a','2026-11-25 12:00:00','me:1',14,NULL,NULL,'ERROR','chat'),
				('a','2026-11-25 12:00:00','me:1',15,3,NULL,'SENT','chat'),
				('a','2026-11-25 12:00:00','me:1',16,NULL,'AUTO_REPLY_RULE:1','SENT','chat'),
				('a','2026-11-25 12:00:00','me:1',17,NULL,NULL,'SENT','reaction'),
				('a','2026-11-25 12:00:00','me:1',NULL,NULL,NULL,'SENT','chat'),
				('b','2026-11-25 12:00:00','me:1',99,NULL,NULL,'SENT','chat')`);
		}
		const start = new Date("2026-08-26T12:00:00Z");
		const end = new Date("2026-11-26T12:00:00Z");
		for (const table of ["internalmessages", "wpp_runtime_internalmessages"]) {
			await db.query(`CREATE TABLE ${table} (instance VARCHAR(40), \`from\` VARCHAR(100), timestamp VARCHAR(191), status VARCHAR(20), type VARCHAR(40))`);
			await db.query(`INSERT INTO ${table} VALUES ?`, [[
				["a", "user:10", String(end.getTime()), "READ", "chat"],
				["a", "user:20", String(start.getTime() / 1000), "RECEIVED", "chat"],
				["a", "user:20", String(end.getTime() - 1), "SENT", "image"],
				["a", "user:20", String(start.getTime() - 1), "SENT", "chat"],
				["a", "user:20", String(end.getTime() + 1), "SENT", "chat"],
				["a", "user:22", String(end.getTime()), "PENDING", "chat"],
				["a", "user:22", String(end.getTime()), "ERROR", "chat"],
				["a", "user:22", String(end.getTime()), "READ", "reaction"],
				["a", "user:22", `${end.getTime()}x`, "READ", "chat"],
				["a", "external:22", String(end.getTime()), "RECEIVED", "chat"],
				["a", "user:9999999999", String(end.getTime()), "READ", "chat"],
				["b", "user:22", String(end.getTime()), "READ", "chat"]
			]]);
		}
		for (const rewrite of [(sql: string) => sql, rewriteRawSql]) {
			type WhatsAppRow = RowDataPacket & { userId: number; messageCount: number; lastSentAt: Date };
			type InternalRow = RowDataPacket & { userId: number; messageCount: number; lastSentMs: number };
			const [rows] = await db.execute<WhatsAppRow[]>(rewrite(ACTIVE_USERS_SQL), ["a", start, end]);
			assert.deepEqual(rows.map(row => [Number(row["userId"]), Number(row["messageCount"])]), [[11, 1], [10, 2]]);
			const [internal] = await db.execute<InternalRow[]>(rewrite(INTERNAL_ACTIVITY_SQL), ["a", start.getTime(), end.getTime()]);
			assert.deepEqual(combineUserActivity(rows, internal), [
				{ userId: 10, whatsappCount: 2, internalCount: 1, lastSentAt: end.getTime() },
				{ userId: 11, whatsappCount: 1, internalCount: 0, lastSentAt: end.getTime() },
				{ userId: 20, whatsappCount: 0, internalCount: 2, lastSentAt: end.getTime() - 1 }
			]);
		}
	} finally { await db.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
