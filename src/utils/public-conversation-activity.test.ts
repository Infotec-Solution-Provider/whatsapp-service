import assert from "node:assert/strict";
import { buildConversationActivityQueries, parseConversationActivityRange } from "./public-conversation-activity";

// Execute the portable predicate against a real SQL engine, with synthetic data only.
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => {
	exec(sql: string): void;
	prepare(sql: string): { all(...values: unknown[]): Array<Record<string, number>> };
	close(): void;
} };
const db = new DatabaseSync(":memory:");
db.exec(`
CREATE TABLE chats (id INTEGER, instance TEXT, contact_id INTEGER, user_id INTEGER, sector_id INTEGER, is_finished INTEGER, started_at TEXT, finished_at TEXT);
CREATE TABLE messages (instance TEXT, chat_id INTEGER, sent_at TEXT);
CREATE TABLE chat_transfer_history (instance TEXT, chat_id INTEGER, transferred_at TEXT);
CREATE TABLE contacts (id INTEGER, instance TEXT, name TEXT, phone TEXT, whatsapp_id TEXT, updated_at TEXT);
INSERT INTO chats VALUES
 (1,'a',11,7,2,0,'2026-10-16T03:00:00.000Z',NULL),
 (2,'a',12,7,2,1,'2026-10-01T03:00:00.000Z','2026-10-17T03:00:00.000Z'),
 (3,'a',13,8,3,0,'2026-10-01T03:00:00.000Z',NULL),
 (4,'a',14,7,2,0,'2026-10-01T03:00:00.000Z',NULL),
 (5,'a',15,7,2,0,'2026-10-01T03:00:00.000Z',NULL),
 (6,'a',16,7,2,0,'2026-10-01T03:00:00.000Z',NULL),
 (7,'b',17,7,2,0,'2026-10-16T03:00:00.000Z',NULL);
INSERT INTO messages VALUES ('a',3,'2026-10-16T12:00:00.000Z'),('a',3,'2026-10-16T13:00:00.000Z'),('b',6,'2026-10-16T12:00:00.000Z');
INSERT INTO chat_transfer_history VALUES ('a',4,'2026-10-16T18:00:00.000Z'),('b',6,'2026-10-16T18:00:00.000Z');
INSERT INTO contacts VALUES
 (11,'a','Alpha','111','111',NULL),(12,'a','Beta','222','222',NULL),
 (15,'a','Linked','555','555','2026-10-16T20:00:00.000Z'),
 (16,'b','Other tenant','666','666','2026-10-16T20:00:00.000Z');
`);
try {
	const range = parseConversationActivityRange("2026-10-16T00:00:00-03:00", "2026-10-17T00:00:00-03:00");
	const run = (extra = {}, page = 1, limit = 100) => {
		const query = buildConversationActivityQueries("a", { page, limit, ...range, ...extra });
		const bind = (values: unknown[]) => values.map(value => value instanceof Date ? value.toISOString() : value);
		return {
			total: db.prepare(query.countSql).all(...bind(query.values))[0]!["total"],
			ids: db.prepare(query.pageSql).all(...bind(query.pageValues)).map(row => row["id"])
		};
	};
	assert.deepEqual(run(), { total: 5, ids: [1, 5, 4, 3, 2] }); // all five activity sources, deduplication, tenant isolation
	assert.deepEqual(run({}, 2, 2), { total: 5, ids: [4, 3] });
	assert.deepEqual(run({}, 4, 2), { total: 5, ids: [] });
	assert.deepEqual(run({ userId: 7, sectorId: 2, isFinished: false }), { total: 3, ids: [1, 5, 4] });
	assert.deepEqual(run({ contactId: 12, finishedFrom: new Date("2026-10-17T03:00:00Z") }), { total: 1, ids: [2] });
	assert.deepEqual(run({ search: "Alpha" }), { total: 1, ids: [1] });
	assert.deepEqual(run({ search: "' OR 1=1 --" }), { total: 0, ids: [] });
	assert.deepEqual(run({ startedTo: new Date("2026-09-01T00:00:00Z") }), { total: 0, ids: [] });
	assert.deepEqual(parseConversationActivityRange(undefined, undefined), {});
	assert.throws(() => parseConversationActivityRange("2026-02-30T00:00:00Z", "2026-03-01T00:00:00Z"), /valid date/);
	assert.throws(() => parseConversationActivityRange("2026-10-16T24:00:00Z", "2026-10-17T00:00:00Z"), /valid date/);
	const fixedNow = new Date("2026-10-18T00:00:00Z");
	assert.equal(parseConversationActivityRange("2026-10-16T00:00:00Z", undefined, fixedNow).updatedTo, fixedNow);
	assert.throws(() => parseConversationActivityRange(undefined, "2026-10-17T00:00:00Z"), /updatedFrom is required/);
	assert.throws(() => parseConversationActivityRange("2026-10-16", undefined), /timezone/);
	assert.throws(() => parseConversationActivityRange(["2026-10-16T00:00:00Z"], undefined), /timezone/);
	assert.throws(() => parseConversationActivityRange("2026-10-18T00:00:00Z", "2026-10-17T00:00:00Z"), /before/);
	assert.throws(() => parseConversationActivityRange("2026-08-01T00:00:00Z", "2026-10-17T00:00:00Z"), /31 days/);
	console.log("public-conversation-activity: SQL filtering, pagination, isolation, binds and boundaries passed");
} finally {
	db.close();
}
