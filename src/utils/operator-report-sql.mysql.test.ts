import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { FIRST_RESPONSE_ELIGIBILITY_SQL, firstResponseSourceSql } from "./operator-report-sql";

// Disposable, network-isolated local containers only. Never accepts a database URL/credential.
const container = process.env["EXATRON_TEST_MYSQL_CONTAINER"] || "";
assert.match(container, /^infotec-exatron-test-mysql(8|55)$/);
assert.equal(execFileSync("docker", ["inspect", "--format", '{{index .Config.Labels "codex.task"}}', container], { encoding: "utf8" }).trim(), "INF-20261019-004");
const sql = (input: string) => execFileSync("docker", ["exec", "-i", container, "mysql", "-uroot", "--batch", "--raw", "--skip-column-names"], { input, encoding: "utf8" }).trim();

sql(`DROP DATABASE IF EXISTS exatron_report_fixture;
CREATE DATABASE exatron_report_fixture;
USE exatron_report_fixture;
CREATE TABLE chats (id INT PRIMARY KEY, instance VARCHAR(30), contact_id INT, user_id INT, is_finished TINYINT DEFAULT 0, finished_at DATETIME);
CREATE TABLE messages (id INT PRIMARY KEY, instance VARCHAR(30), chat_id INT, user_id INT, \`from\` VARCHAR(40), \`to\` VARCHAR(40), body TEXT, sent_at DATETIME, INDEX(instance,chat_id,sent_at,id));
INSERT INTO chats(id,instance,contact_id,user_id,is_finished,finished_at) VALUES
(1,'a',101,10,0,NULL),(2,'a',102,10,0,NULL),(3,'a',103,20,0,NULL),
(4,'a',104,10,0,NULL),(5,'a',105,10,0,NULL),(50,'a',105,10,1,'2026-10-01 08:55:00'),
(6,'a',106,10,0,NULL),(7,'b',107,10,0,NULL),(8,'a',108,10,0,NULL),
(10,'a',110,1,0,NULL),(11,'a',111,NULL,0,NULL),(12,'a',112,NULL,0,NULL),
(13,'a',113,10,0,NULL),(14,'a',114,10,0,NULL),(15,'a',115,10,0,NULL);
INSERT INTO messages(id,instance,chat_id,user_id,\`from\`,\`to\`,body,sent_at) VALUES
(1,'a',1,NULL,'5501','me:55','help','2026-10-01 09:00:00'),
(2,'a',1,NULL,'bot:55','5501','automatic','2026-10-01 09:01:00'),
(3,'a',1,10,'me:55','5501','answer','2026-10-01 09:05:00'),
(4,'a',1,10,'me:55','5501','second answer','2026-10-01 09:06:00'),
(5,'a',2,NULL,'5502','me:55','help','2026-10-01 23:00:00'),
(6,'a',2,10,'me:55','5502','answer','2026-10-02 01:00:00'),
(7,'a',3,NULL,'5503','me:55','help','2026-10-01 10:00:00'),
(8,'a',3,NULL,'me:55','5503','template','2026-10-01 10:02:00'),
(9,'a',4,NULL,'5504','me:55','help','2026-10-01 09:00:00'),
(10,'a',4,NULL,'bot:55','5504','automatic','2026-10-01 09:01:00'),
(11,'a',5,NULL,'5505','me:55','ok','2026-10-01 09:00:00'),
(12,'a',5,10,'me:55','5505','answer','2026-10-01 09:01:00'),
(13,'a',6,NULL,'5506','me:55','help','2026-10-01 11:00:00'),
(14,'a',6,10,'me:55','5506','same instant','2026-10-01 11:00:00'),
(15,'a',6,10,'me:55','5506','later','2026-10-01 11:00:02'),
(16,'b',7,NULL,'5507','me:55','help','2026-10-01 09:00:00'),
(17,'b',7,10,'me:55','5507','answer','2026-10-01 09:01:00'),
(18,'a',8,NULL,'5508','me:55','help','2026-10-03 09:00:00'),
(19,'a',8,10,'me:55','5508','outside period','2026-10-03 09:01:00'),
(20,'a',10,NULL,'5510','me:55','help','2026-10-01 09:00:00'),
(21,'a',10,1,'me:55','5510','excluded admin','2026-10-01 09:01:00'),
(22,'a',11,NULL,'5511','me:55','help','2026-10-01 09:00:00'),
(23,'a',11,10,'me:55','5511','human without chat owner','2026-10-01 09:00:30'),
(24,'a',12,NULL,'5512','me:55','help','2026-10-01 09:00:00'),
(25,'a',12,NULL,'me:55','5512','no author or owner','2026-10-01 09:01:00'),
(26,'a',13,10,'me:55','5513','outbound only','2026-10-01 09:01:00'),
(27,'a',14,10,'me:55','5514','before customer','2026-10-01 09:00:00'),
(28,'a',14,NULL,'5514','me:55','help','2026-10-01 09:01:00'),
(29,'a',15,NULL,'5515','me:55','help','2026-10-02 09:00:00'),
(30,'a',15,20,'me:55','5515','different initiator','2026-10-02 09:00:30');`);

const source = `${firstResponseSourceSql("AND msg.sent_at >= ? AND msg.sent_at <= ?")}
WHERE ch.instance = ? AND ${FIRST_RESPONSE_ELIGIBILITY_SQL}
AND response.sent_at >= ? AND response.sent_at <= ?
AND COALESCE(response.user_id,ch.user_id) <> 1`;
function query(select: string, tail = "") {
	const statement = `${select} ${source} ${tail}`.replaceAll("'", "''");
	return sql(`USE exatron_report_fixture;
SET @tenant='a', @start='2026-10-01 00:00:00', @end='2026-10-02 23:59:59';
PREPARE report_query FROM '${statement}';
EXECUTE report_query USING @tenant,@start,@end,@tenant,@start,@end;
DEALLOCATE PREPARE report_query;`).split("\n").filter(Boolean).map((line) => line.split("\t"));
}

const detail = query("SELECT ch.id,COALESCE(response.user_id,ch.user_id),TIMESTAMPDIFF(SECOND,customer.sent_at,response.sent_at)", "ORDER BY ch.id");
assert.deepEqual(detail.map((r) => r.map(Number)), [[1,10,300],[3,20,120],[6,10,2],[11,10,30],[15,20,30]]);
const summary = query("SELECT COUNT(*),SUM(TIMESTAMPDIFF(SECOND,customer.sent_at,response.sent_at)),AVG(TIMESTAMPDIFF(SECOND,customer.sent_at,response.sent_at))");
assert.deepEqual(summary[0]!.map(Number), [5,482,96.4]);
const daily = query("SELECT DATE(response.sent_at),COUNT(*),SUM(TIMESTAMPDIFF(SECOND,customer.sent_at,response.sent_at))", "GROUP BY DATE(response.sent_at) ORDER BY DATE(response.sent_at)");
assert.deepEqual(daily, [["2026-10-01","4","452"],["2026-10-02","1","30"]]);
assert.equal(detail.reduce((sum,r) => sum+Number(r[2]),0), Number(summary[0]![1]));
assert.equal(daily.reduce((sum,r) => sum+Number(r[1]),0), detail.length);
console.log(`${container}: first-response summary/daily/details agree; tenant, date, bot, template, courtesy, author and tie fixtures passed`);
