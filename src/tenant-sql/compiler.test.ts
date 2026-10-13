import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { compileOrderBy, compileWhere, rewriteRawSql } from "./compiler";
import { field, hydrate, model, models, scalarData, table } from "./metadata";

test("metadata retains mapped fields and both directions of ordinary and implicit relations", () => {
	assert.equal(table("wppMessage"), "wpp_runtime_messages");
	assert.equal(field("WppMessage", "chatId").column, "chat_id");
	assert.deepEqual(model("wppChat").relations["contact"]!.localFields, ["contactId"]);
	assert.deepEqual(model("wppContact").relations["WppChat"]!.targetFields, ["contactId"]);
	assert.deepEqual(model("wppChat").relations["wppTags"]!.join, {
		table: "wpp_runtime__WppChatToWppTag", localColumn: "A", targetColumn: "B",
	});
	assert.equal(model("wppTag").relations["wppChats"]!.join!.localColumn, "B");
	assert.ok(models.every(item => !["ProcessLog", "InstanceMigrationRun", "FrontendPerformanceSession"].includes(item.name)));
	assert.throws(() => model("processLog"), /MODEL_UNSUPPORTED/);
});

test("compound unique keys, booleans and dates compile without inserting values into SQL", () => {
	const attack = "x' OR 1=1 --";
	const compiled = compileWhere("operatorOutboundSend", {
		instance_userId_idempotencyKey: { instance: attack, userId: 71, idempotencyKey: "abc" },
		attemptStartedAt: { not: null },
		createdAt: { gte: new Date("2026-10-13T00:00:00Z") },
	}, "t");
	assert.ok(!compiled.sql.includes(attack));
	assert.match(compiled.sql, /`t`\.`attempt_started_at` IS NOT NULL/);
	assert.deepEqual(compiled.params.slice(0, 3), [attack, 71, "abc"]);
	assert.ok(compiled.params[3] instanceof Date);
	assert.throws(() => compileWhere("operatorOutboundSend", { instance_userId_idempotencyKey: { instance: "a", userId: 1 } }), /COMPOUND_KEY_INVALID/);
});

test("boolean combinations and empty lists retain their filtering semantics", () => {
	const compiled = compileWhere("wppMessage", {
		instance: "alpha", OR: [{ status: { in: [] } }, { contactId: null }],
		NOT: [{ from: { startsWith: "system" } }, { isEdited: true }],
		id: { notIn: [] }, ignored: undefined,
	}, "m");
	assert.match(compiled.sql, /0=1/);
	assert.match(compiled.sql, /`m`\.`contact_id` IS NULL/);
	assert.match(compiled.sql, /NOT \(/);
	assert.deepEqual(compiled.params, ["alpha", "system%", 1]);
	assert.equal(compileWhere("wppMessage", { OR: [] }).sql, "(0=1)");
	assert.equal(compileWhere("wppMessage", { AND: [] }).sql, "(1=1)");
});

test("literal LIKE wildcards are escaped and unknown operators cannot silently widen a filter", () => {
	const compiled = compileWhere("wppContact", { name: { contains: "a!b%_c" } });
	assert.match(compiled.sql, /LIKE \? ESCAPE '!'/);
	assert.deepEqual(compiled.params, ["%a!!b!%!_c%"]);
	assert.throws(() => compileWhere("wppContact", { name: { unsupported: true } }), /FILTER_UNSUPPORTED/);
	assert.throws(() => compileWhere("wppContact", { "id` OR 1=1": 1 }), /WHERE_FIELD_UNSUPPORTED/);
});

test("nested list and singular relation predicates use correlated tenant tables", () => {
	const compiled = compileWhere("wppChat", {
		contact: { is: { instance: "alpha", sectors: { some: { sectorId: { in: [9, 10] } } } } },
		messages: { none: { status: "ERROR" }, every: { isEdited: false } },
	}, "chat");
	assert.match(compiled.sql, /FROM `wpp_runtime_contacts` `r1`/);
	assert.match(compiled.sql, /`r1`\.`id` = `chat`\.`contact_id`/);
	assert.match(compiled.sql, /FROM `wpp_runtime_contacts_sectors` `r2`/);
	assert.match(compiled.sql, /`r2`\.`contactId` = `r1`\.`id`/);
	assert.match(compiled.sql, /NOT EXISTS/);
	assert.match(compiled.sql, /AND NOT \(/);
	assert.deepEqual(compiled.params, ["alpha", 9, 10, "ERROR", 0]);
	assert.match(compileWhere("wppChat", { contact: { isNot: null } }, "chat").sql, /EXISTS/);
	assert.doesNotMatch(compileWhere("wppChat", { contact: { isNot: null } }, "chat").sql, /NOT EXISTS/);
});

test("implicit many-to-many predicates use the correct sides of the relation join", () => {
	const forward = compileWhere("wppChat", { wppTags: { some: { name: "priority" } } }, "chat");
	assert.match(forward.sql, /JOIN `wpp_runtime__WppChatToWppTag` `j1` ON `j1`\.`B` = `r1`\.`id`/);
	assert.match(forward.sql, /`j1`\.`A` = `chat`\.`id`/);
	const reverse = compileWhere("wppTag", { wppChats: { none: { isFinished: false } } }, "tag");
	assert.match(reverse.sql, /`j1`\.`A` = `r1`\.`id`/);
	assert.match(reverse.sql, /`j1`\.`B` = `tag`\.`id`/);
});

test("orders validate directions and support scalar, aggregation and relation counts", () => {
	assert.equal(compileOrderBy("wppMessage", [{ sentAt: "desc" }, { id: "asc" }], "m"), "`m`.`sent_at` DESC, `m`.`id` ASC");
	assert.equal(compileOrderBy("wppMessage", { _count: { id: "asc" } }), "COUNT(`id`) ASC");
	assert.match(compileOrderBy("internalWhatsappSender", [{ messages: { _count: "desc" } }, { updatedAt: "desc" }], "s"), /SELECT COUNT\(\*\) FROM `wpp_runtime_internalmessages` `o1` WHERE `o1`\.`whatsapp_sender_id` = `s`\.`id`/);
	assert.throws(() => compileOrderBy("wppMessage", { id: "desc; DROP TABLE x" }), /ORDER_DIRECTION_INVALID/);
});

test("scalar storage and hydration preserve UTC dates, JSON, false and SQL null", () => {
	const date = new Date("2026-10-13T14:01:02.123Z");
	const stored = scalarData("wppMessage", { isEdited: false, sentAt: date, mentionMetadata: { users: [7] }, fileName: null });
	assert.deepEqual(stored, { is_edited: 0, sent_at: date, mention_metadata: '{"users":[7]}', file_name: null });
	const read = hydrate("wppMessage", { id: "42", is_edited: "0", sent_at: "2026-10-13 14:01:02.123", mention_metadata: '{"users":[7]}', file_name: null });
	assert.deepEqual(read, { id: 42, isEdited: false, sentAt: date, mentionMetadata: { users: [7] }, fileName: null });
	assert.deepEqual(scalarData("wppMessage", { mentionMetadata: Prisma.JsonNull }), { mention_metadata: "null" });
	assert.deepEqual(scalarData("wppMessage", { mentionMetadata: Prisma.DbNull }), { mention_metadata: null });
});

test("raw table rewriting ignores strings, comments, aliases and columns", () => {
	const original = "SELECT 'FROM messages JOIN chats', \"JOIN contacts\", `from`, messages AS messages FROM `messages` m /* JOIN contacts */ JOIN chats c ON m.chat_id=c.id WHERE m.body='it\\'s FROM contacts' -- FROM clients\nAND m.type=?";
	assert.equal(rewriteRawSql(original), original.replace("FROM `messages` m", "FROM `wpp_runtime_messages` m").replace("JOIN chats c", "JOIN `wpp_runtime_chats` c"));
	assert.equal(rewriteRawSql("UPDATE messages SET body='messages' WHERE id=?"), "UPDATE `wpp_runtime_messages` SET body='messages' WHERE id=?");
	assert.equal(rewriteRawSql("INSERT INTO _WppChatToWppTag (A,B) VALUES (?,?)"), "INSERT INTO `wpp_runtime__WppChatToWppTag` (A,B) VALUES (?,?)");
	assert.equal(rewriteRawSql("SELECT `from` messages FROM contacts"), "SELECT `from` messages FROM `wpp_runtime_contacts`");
	assert.equal(rewriteRawSql("SELECT * FROM wpp_runtime_messages"), "SELECT * FROM wpp_runtime_messages");
});
