import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { rewriteRawSql } from "../tenant-sql/compiler";
import { ACTIVE_USERS_SQL, threeMonthsBefore } from "./active-users-report.service";

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
		for (const sql of [ACTIVE_USERS_SQL, rewriteRawSql(ACTIVE_USERS_SQL)]) {
			const [rows] = await db.execute<RowDataPacket[]>(sql, ["a", new Date("2026-08-26T12:00:00Z"), new Date("2026-11-26T12:00:00Z")]);
			assert.deepEqual(rows.map(row => [Number(row["userId"]), Number(row["messageCount"])]), [[11, 1], [10, 2]]);
		}
	} finally { await db.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
