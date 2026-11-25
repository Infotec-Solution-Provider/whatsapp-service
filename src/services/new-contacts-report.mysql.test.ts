import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createConnection, type Connection, type RowDataPacket } from "mysql2/promise";
import type { ExecuteValues } from "mysql2";
import { rewriteRawSql } from "../tenant-sql/compiler";
import { compileRawPagination } from "../tenant-sql/raw-pagination";
import { parseNewContactsQuery } from "./new-contacts-report.contract";
import { buildNewContactsQueries } from "./new-contacts-report.query";

async function seed(database: Connection, prefix: string) {
	await database.query(`CREATE TABLE ${prefix}messages (
		id INT PRIMARY KEY, instance VARCHAR(50), contact_id INT, chat_id INT, client_id INT,
		sent_at DATETIME(3), \`from\` VARCHAR(60), \`to\` VARCHAR(60), user_id INT,
		type VARCHAR(40), status VARCHAR(20), agent_id INT, billing_category VARCHAR(80),
		INDEX messages_instance_sent_at_chat_id_idx(instance, sent_at, chat_id),
		INDEX messages_instance_chat_id_sent_at_id_idx(instance, chat_id, sent_at, id),
		INDEX messages_contact_id_fkey(contact_id)
	)`);
	await database.query(`CREATE TABLE ${prefix}contacts (
		id INT PRIMARY KEY, instance VARCHAR(50), customer_id INT, name VARCHAR(50), is_deleted BOOLEAN, whatsapp_id VARCHAR(50)
	)`);
	await database.query(`CREATE TABLE ${prefix}chats (
		id INT PRIMARY KEY, instance VARCHAR(50), contact_id INT, started_at DATETIME(3),
		user_id INT, sector_id INT, is_finished BOOLEAN, INDEX(instance, contact_id)
	)`);
	await database.query(`CREATE TABLE ${prefix}clients (id INT PRIMARY KEY, instance VARCHAR(50), name VARCHAR(50))`);
	await database.query(`CREATE TABLE ${prefix}sectors (id INT PRIMARY KEY, instance VARCHAR(50), name VARCHAR(50))`);

	await database.query(`INSERT INTO ${prefix}contacts VALUES
		(1,'suprimaxxi',71,'A',0,'1001'), (2,'suprimaxxi',72,'B',0,'1002'), (3,'suprimaxxi',73,'C',0,'1003'),
		(4,'suprimaxxi',NULL,'D',0,'1004'), (5,'suprimaxxi',0,'E',0,'1005'), (6,'other',76,'F',0,'1006'),
		(7,'suprimaxxi',77,'G',0,'1007'), (8,'suprimaxxi',NULL,'Group',0,'123@g.us')`);
	await database.query(`INSERT INTO ${prefix}chats VALUES
		(11,'suprimaxxi',1,'2026-11-24 03:00:00',8,1,1),
		(12,'suprimaxxi',1,'2026-11-25 12:00:00',8,1,0),
		(13,'suprimaxxi',1,'2026-11-25 12:00:00',11,1,1),
		(51,'suprimaxxi',5,'2026-11-24 05:00:00',12,1,0),
		(71,'suprimaxxi',7,'2026-11-24 06:00:00',-1,1,0),
		(72,'other',7,'2026-11-25 00:00:00',99,2,0)`);
	await database.query(`INSERT INTO ${prefix}clients VALUES (1,'suprimaxxi','Recepção'), (2,'suprimaxxi','Outro canal')`);
	await database.query(`INSERT INTO ${prefix}sectors VALUES (1,'suprimaxxi','Atendimento'), (2,'other','Outro tenant')`);
	await database.query(`INSERT INTO ${prefix}messages VALUES
		(1,'suprimaxxi',1,11,1,'2026-11-24 03:00:00.000','1001','me:account',NULL,'chat','RECEIVED',NULL,NULL),
		(2,'suprimaxxi',1,11,1,'2026-11-24 03:00:01.000','me:account','1001',9,'chat','SENT',3,NULL),
		(3,'suprimaxxi',1,11,1,'2026-11-24 03:00:02.000','system:auto-reply','1001',NULL,'chat','SENT',NULL,'AUTO_REPLY_RULE:7'),
		(4,'suprimaxxi',1,11,1,'2026-11-24 03:00:03.000','me:account','1001',7,'chat','ERROR',NULL,NULL),
		(5,'suprimaxxi',1,12,1,'2026-11-24 03:00:04.000','me:account','1001',8,'chat','SENT',NULL,NULL),
		(6,'suprimaxxi',1,11,1,'2026-11-24 03:01:00.000','me:account','1001',12,'chat','SENT',NULL,NULL),
		(7,'suprimaxxi',1,11,1,'2026-11-24 03:02:00.000','me:account','1001',11,'chat','SENT',NULL,NULL),
		(8,'suprimaxxi',2,NULL,2,'2026-11-24 02:59:59.999','1002','me:account',NULL,'chat','RECEIVED',NULL,NULL),
		(9,'suprimaxxi',2,NULL,1,'2026-11-24 03:01:00.000','1002','me:account',NULL,'chat','RECEIVED',NULL,NULL),
		(10,'suprimaxxi',3,NULL,1,'2026-11-25 03:00:00.000','1003','me:account',NULL,'chat','RECEIVED',NULL,NULL),
		(11,'suprimaxxi',4,NULL,1,'2026-11-24 03:01:00.000','1004','me:account',NULL,'reaction','RECEIVED',NULL,NULL),
		(12,'suprimaxxi',4,NULL,1,'2026-11-24 03:02:00.000','1004','700@g.us',NULL,'chat','RECEIVED',NULL,NULL),
		(13,'suprimaxxi',4,NULL,1,'2026-11-24 03:03:00.000','thirdparty:meta','1004',NULL,'thirdparty:meta','RECEIVED',NULL,NULL),
		(14,'suprimaxxi',4,NULL,2,'2026-11-24 04:00:00.000','1004','me:account',NULL,'audio','RECEIVED',NULL,NULL),
		(15,'suprimaxxi',4,NULL,1,'2026-11-24 04:01:00.000','1004','me:account',NULL,'chat','RECEIVED',NULL,NULL),
		(16,'suprimaxxi',5,51,1,'2026-11-24 05:00:00.000','1005','me:account',NULL,'chat','RECEIVED',NULL,NULL),
		(17,'suprimaxxi',5,51,1,'2026-11-24 05:01:00.000','me:account','1005',NULL,'chat','READ',NULL,NULL),
		(18,'suprimaxxi',5,51,1,'2026-11-24 05:02:00.000','me:account','1005',12,'chat','SENT',NULL,NULL),
		(19,'other',6,NULL,1,'2026-11-24 05:00:00.000','1006','me:account',NULL,'chat','RECEIVED',NULL,NULL),
		(20,'suprimaxxi',7,71,1,'2026-11-24 06:00:00.000','1007','me:account',NULL,'chat','RECEIVED',NULL,NULL),
		(21,'suprimaxxi',7,71,1,'2026-11-24 06:00:00.000','user:12','1007',NULL,'chat','SENT',NULL,NULL),
		(22,'suprimaxxi',8,NULL,1,'2026-11-24 06:00:00.000','1008','me:account',NULL,'chat','RECEIVED',NULL,NULL),
		(23,'other',7,NULL,1,'2026-11-24 02:00:00.000','1007','me:account',NULL,'chat','RECEIVED',NULL,NULL)`);
}

async function verifyQueries(execute: (sql: string, params: unknown[]) => Promise<RowDataPacket[]>) {
	const period = { from: "2026-11-24", to: "2026-11-24" };
	const queriedAt = new Date("2026-11-26T00:00:00Z");
	const fetch = async (request: unknown, instance = "suprimaxxi") => {
		const query = parseNewContactsQuery(request);
		const { summary, rows } = buildNewContactsQueries(instance, query, queriedAt);
		const counts = await execute(summary.sql, summary.params);
		const contacts = await execute(rows.sql, rows.params);
		return { counts, contacts };
	};
	const first = await fetch({ filters: period, pageSize: 2 });
	assert.deepEqual(first.contacts.map(row => row["contactId"]), [7, 5]);
	const groups = (rows: RowDataPacket[]) => rows.map(row => [
		row["ownerId"] === null ? null : Number(row["ownerId"]),
		Number(row["count"])
	]);
	assert.deepEqual(groups(first.counts), [[null, 2], [11, 1], [12, 1]]);
	assert.deepEqual(first.contacts.map(row => [row["firstReplyStatus"], row["firstReplySeconds"] === null ? null : Number(row["firstReplySeconds"])]),
		[["identified", 0], ["unidentified", null]]);

	const second = await fetch({ filters: period, page: 2, pageSize: 2 });
	assert.deepEqual(second.contacts.map(row => [row["contactId"], row["latestChatId"], row["status"], row["firstReplyStatus"]]),
		[[4, null, "no_chat", "none"], [1, 13, "finished", "identified"]]);
	assert.equal(Number(second.contacts[1]!["ownerId"]), 11);
	assert.equal(Number(second.contacts[1]!["firstResponderId"]), 12);
	assert.equal(Number(second.contacts[1]!["firstReplySeconds"]), 60);
	assert.equal(second.contacts[1]!["firstInboundAt"].toISOString(), "2026-11-24T03:00:00.000Z");

	const filtered = await fetch({ filters: { ...period, firstChannelIds: [1], firstResponderIds: [12], sectorIds: [1] },
		sort: { field: "firstInboundAt", direction: "asc" }, exportLimit: 1 });
	assert.deepEqual(filtered.contacts.map(row => row["contactId"]), [1, 7]);
	assert.deepEqual(groups(filtered.counts), [[null, 1], [11, 1]]);
	const exportRequest = { filters: period, sort: { field: "firstInboundAt", direction: "asc" }, exportLimit: 2 };
	const initialBatch = await fetch({ ...exportRequest, exportOffset: 0 });
	const nextBatch = await fetch({ ...exportRequest, exportOffset: 2 });
	assert.deepEqual(initialBatch.contacts.map(row => row["contactId"]), [1, 4]);
	assert.deepEqual(nextBatch.contacts.map(row => row["contactId"]), [5, 7]);
	assert.deepEqual(groups(nextBatch.counts), groups(initialBatch.counts));
	const openUnlinked = await fetch({ filters: { ...period, status: "open", linked: false } });
	assert.deepEqual(openUnlinked.contacts.map(row => row["contactId"]), [5]);

	const other = await fetch({ filters: period }, "other");
	assert.deepEqual(other.contacts.map(row => [row["contactId"], row["firstChannelName"], row["ownerId"]]), [[6, null, null]]);
	assert.deepEqual(groups(other.counts), [[null, 1]]);
}

async function main() {
	const container = "infotec-new-contacts-report-20261125";
	const address = execFileSync("docker", ["port", container, "3306/tcp"], { encoding: "utf8" }).trim();
	const port = /^127\.0\.0\.1:(\d+)$/.exec(address)?.[1];
	assert.ok(port, "Expose the disposable MySQL fixture on a loopback port.");
	const database = await createConnection({ host: "127.0.0.1", port: Number(port), user: "root", timezone: "Z" });
	const schema = "report_fixture_" + randomUUID().replaceAll("-", "");
	const prisma = new PrismaClient({ datasourceUrl: `mysql://root@127.0.0.1:${port}/${schema}` });
	try {
		await database.query(`CREATE DATABASE ${schema}`);
		await database.changeUser({ database: schema });
		await seed(database, "");
		await seed(database, "wpp_runtime_");
		await verifyQueries((sql, params) => prisma.$queryRawUnsafe<RowDataPacket[]>(sql, ...params));
		await verifyQueries(async (sql, params) => {
			const prepared = compileRawPagination(rewriteRawSql(sql), params);
			const [rows] = await database.execute<RowDataPacket[]>(prepared.sql, prepared.values as ExecuteValues);
			return rows;
		});
		console.log("New contacts fixtures passed on central and tenant-runtime table layouts.");
	} finally {
		await prisma.$disconnect();
		await database.query(`DROP DATABASE IF EXISTS ${schema}`);
		await database.end();
	}
}

void main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
