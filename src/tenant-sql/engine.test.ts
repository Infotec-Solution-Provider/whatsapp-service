import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import type { Pool } from "mysql2/promise";
import { createNativeTenantClient, operationDescriptor } from "./engine";

interface Call { target: string; sql: string; values: any[] }
function harness(reply: (sql: string, values: any[]) => any = () => []) {
	const calls: Call[] = [];
	const events: string[] = [];
	let commitError: Error | undefined;
	const execute = (target: string) => async (input: string | { sql: string; values: any[] }, parameters: any[] = []) => {
		const sql = typeof input === "string" ? input : input.sql;
		const values = typeof input === "string" ? parameters : input.values;
		calls.push({ target, sql, values }); return [await reply(sql, values), []];
	};
	const connection = {
		execute: execute("connection"), query: execute("connection"),
		beginTransaction: async () => { events.push("begin"); },
		commit: async () => { events.push("commit"); if (commitError) throw commitError; },
		rollback: async () => { events.push("rollback"); },
		release: () => { events.push("release"); },
		destroy: () => { events.push("destroy"); },
	};
	const pool = { execute: execute("pool"), getConnection: async () => { events.push("acquire"); return connection; }, end: async () => { events.push("end"); } } as unknown as Pool;
	const client = createNativeTenantClient("tenant-a", pool);
	return { client, pool, connection, calls, events, failCommit: (error: Error) => { commitError = error; } };
}

test("CRM schedule mutations retain tenant, pending state and owner predicates in the native write", async () => {
	const h = harness(sql => {
		if (sql.startsWith("SELECT")) return [{ id: 9, instance: "tenant-a", chat_id: null, scheduled_by: 7, scheduled_for: 8 }];
		return { affectedRows: 1 };
	});
	await h.client["wppSchedule"].update({
		where: { id: 9, instance: "tenant-a", AND: [{ chatId: null }], OR: [{ scheduledBy: 7 }, { scheduledFor: 7 }] },
		data: { description: "Fixture" }
	});
	const mutation = h.calls.find(call => call.sql.startsWith("UPDATE"));
	assert.ok(mutation);
	assert.match(mutation.sql, /`instance`/); assert.match(mutation.sql, /`chat_id` IS NULL/);
	assert.match(mutation.sql, /`scheduled_by`/); assert.match(mutation.sql, /`scheduled_for`/);
	assert.match(mutation.sql, / OR /); assert.ok(mutation.values.includes("tenant-a")); assert.ok(mutation.values.includes(7));
});

test("delegates are lazy, scope tenant data and hydrate scalar results", async () => {
	const h = harness(() => [{ id: 3, instance: "tenant-a", isDeleted: 0, updatedAt: "2026-10-13 12:30:00.000" }]);
	const query = h.client["wppContact"].findMany({ where: { name: "O'Reilly" }, orderBy: { id: "desc" }, take: 2, skip: 1 });
	assert.equal(h.calls.length, 0);
	assert.equal(operationDescriptor(query)?.model, "WppContact");
	const rows = await query;
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.calls[0]!.values, ["O'Reilly", "tenant-a"]);
	assert.match(h.calls[0]!.sql, /FROM `wpp_runtime_contacts`/);
	assert.match(h.calls[0]!.sql, /ORDER BY `id` DESC LIMIT 2 OFFSET 1/);
	assert.equal(rows[0].isDeleted, false);
	assert.equal(rows[0].updatedAt.toISOString(), "2026-10-13T12:30:00.000Z");
	assert.equal((await query)[0], rows[0]);
	assert.equal(h.calls.length, 1);
});

test("array transactions execute every lazy operation on one connection", async () => {
	const h = harness(sql => sql.includes("COUNT(*)") ? [{ a0: 2 }] : [{ id: 3 }]);
	const read = h.client["wppContact"].findMany({ where: { instance: "tenant-a" } });
	const count = h.client["wppContact"].count();
	assert.equal(h.calls.length, 0);
	assert.deepEqual(await h.client.$transaction([read, count]), [[{ id: 3 }], 2]);
	assert.deepEqual(h.events, ["acquire", "begin", "commit", "release"]);
	assert.deepEqual(h.calls.map(c => c.target), ["connection", "connection"]);
	await assert.rejects(h.client.$transaction([read]), /previously awaited/);
});

test("callbacks bind delegates and raw SQL to the transaction connection", async () => {
	const h = harness(sql => sql.startsWith("UPDATE") ? { affectedRows: 1 } : [{ id: 8 }]);
	await h.client.$transaction(async tx => {
		await tx.wppContact.findUnique({ where: { id: 8 } });
		await tx.$executeRaw(Prisma.sql`UPDATE contacts SET name = ${"safe"} WHERE id = ${8}`);
	});
	assert.deepEqual(h.calls.map(c => c.target), ["connection", "connection"]);
	assert.match(h.calls[1]!.sql, /UPDATE `wpp_runtime_contacts` SET name = \?/);
	assert.deepEqual(h.calls[1]!.values, ["safe", 8]);
});

test("raw prepared pagination rewrites tenant tables and retains bound search values", async () => {
	const h = harness();
	await h.client.$queryRawUnsafe("SELECT id FROM contacts WHERE instance = ? AND name LIKE ? LIMIT ? OFFSET ?", "tenant-a", "%O'Reilly\\%", 20, 40);
	assert.equal(h.calls[0]!.sql, "SELECT id FROM `wpp_runtime_contacts` WHERE instance = ? AND name LIKE ? LIMIT 20 OFFSET 40");
	assert.deepEqual(h.calls[0]!.values, ["tenant-a", "%O'Reilly\\%"]);
	await assert.rejects(Promise.resolve(h.client.$queryRawUnsafe("SELECT id FROM contacts LIMIT ?", -1)), /PAGINATION_INVALID/);
	assert.equal(h.calls.length, 1);
});

test("an array operation cannot escape while its transaction waits for a connection", async () => {
	const h = harness();
	let acquire!: () => void;
	(h.pool as any).getConnection = () => new Promise(resolve => { acquire = () => resolve(h.connection); });
	const query = h.client["wppContact"].findMany();
	const transaction = h.client.$transaction([query]);
	await assert.rejects(Promise.resolve(query), /reserved for its transaction/);
	assert.equal(h.calls.length, 0);
	acquire();
	await transaction;
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.calls.map(c => c.target), ["connection"]);
});

test("cross-tenant and eagerly started operations are rejected before acquisition", async () => {
	const h = harness();
	const other = createNativeTenantClient("tenant-b", h.pool);
	await assert.rejects(h.client.$transaction([other["wppContact"].findMany()]), /Cross-tenant/);
	assert.equal(h.events.length, 0);
	const query = h.client["wppContact"].findMany();
	await query;
	await assert.rejects(h.client.$transaction([query]), /previously awaited/);
	assert.deepEqual(h.events, ["acquire", "release"]);
});

test("unknown commit outcomes are surfaced once and never retried", async () => {
	const h = harness(() => ({ affectedRows: 1 }));
	const unknown = new Error("connection lost during commit");
	h.failCommit(unknown);
	await assert.rejects(h.client.$transaction(async tx => { await tx.wppContact.updateMany({ data: { name: "test" } }); }), error => (error as any).code === "TENANT_COMMIT_UNKNOWN" && (error as any).outcome === "UNKNOWN" && (error as Error).cause === unknown);
	assert.deepEqual(h.events, ["acquire", "begin", "commit", "destroy"]);
	assert.equal(h.calls.length, 1);
});

test("captured callback clients cannot issue queries after a successful commit", async () => {
	const h = harness();
	let captured: any;
	await h.client.$transaction(async tx => { captured = tx; await tx.wppContact.findMany(); });
	const before = h.calls.length;
	await assert.rejects(Promise.resolve(captured.wppContact.findMany()), error => (error as any).code === "TENANT_TRANSACTION_CLOSED");
	assert.equal(h.calls.length, before);
	assert.deepEqual(h.events, ["acquire", "begin", "commit", "release"]);
});

test("transaction timeout destroys the session and rejects delayed callback writes", async () => {
	const h = harness();
	let resume!: () => void;
	let captured: any;
	const transaction = h.client.$transaction(async tx => {
		captured = tx;
		await new Promise<void>(resolve => { resume = resolve; });
		await tx.wppContact.updateMany({ data: { name: "late" } });
	}, { timeout: 5 });
	await assert.rejects(transaction, error => (error as any).code === "TENANT_TRANSACTION_TIMEOUT");
	resume();
	await assert.rejects(Promise.resolve(captured.wppContact.findMany()), error => (error as any).code === "TENANT_TRANSACTION_CLOSED");
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(h.calls.length, 0);
	assert.deepEqual(h.events, ["acquire", "begin", "destroy"]);
});

test("native duplicate and missing records preserve service error compatibility", async () => {
	const h = harness(sql => { if (sql.startsWith("INSERT")) throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY", sqlMessage: "Duplicate entry for key 'contacts.contacts_phone_key'" }); return []; });
	await assert.rejects(Promise.resolve(h.client["wppContact"].create({ data: { name: "Alice", phone: "1" } })), error => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002");
	await assert.rejects(Promise.resolve(h.client["wppContact"].findUniqueOrThrow({ where: { id: 99 } })), error => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025");
	assert.deepEqual(h.events, ["acquire", "begin", "rollback", "release", "acquire", "release"]);
});

test("create rejects a foreign tenant and supplies UUID, JSON and timestamps", async () => {
	let created: Record<string, any> = {};
	const h = harness((sql, values) => {
		if (sql.startsWith("INSERT")) {
			const columns = /\(([^)]+)\) VALUES/.exec(sql)![1]!.split(", ").map(k => k.replace(/`/g, ""));
			created = Object.fromEntries(columns.map((key, index) => [key, values[index]]));
			return { insertId: 0, affectedRows: 1 };
		}
		return [created];
	});
	await assert.rejects(Promise.resolve(h.client["operatorOutboundSend"].create({ data: { instance: "tenant-b" } })), /Tenant mismatch/);
	assert.equal(h.calls.length, 0);
	const row = await h.client["operatorOutboundSend"].create({ data: { userId: 4, clientId: 2, idempotencyKey: "k", payloadHash: "h", payload: { body: "Olá 👋" }, messageId: 7, deliveryMode: "REMOTE" } });
	assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
	assert.equal(row.instance, "tenant-a");
	assert.equal(row.status, "PENDING");
	assert.deepEqual(row.payload, { body: "Olá 👋" });
	assert.equal(row.attemptCount, 0);
	assert.ok(row.updatedAt instanceof Date);
});

test("nested inverse replacement is atomic and constrained to its parent", async () => {
	const h = harness(sql => {
		if (sql.includes("FROM `wpp_runtime_contacts`")) return [{ id: 12, instance: "tenant-a", name: "Alice" }];
		if (sql.includes("FROM `wpp_runtime_contacts_sectors`")) return [{ contactId: 12, sectorId: 4 }];
		return { affectedRows: 1, insertId: 0 };
	});
	const result = await h.client["wppContact"].update({ where: { id: 12 }, data: { sectors: { deleteMany: {}, create: [{ sectorId: 4 }] } }, include: { sectors: true } });
	assert.equal(result.sectors[0].contactId, 12);
	const deletion = h.calls.find(c => c.sql.startsWith("DELETE"))!;
	assert.deepEqual(deletion.values, [12]);
	const insertion = h.calls.find(c => c.sql.startsWith("INSERT"))!;
	assert.deepEqual(insertion.values, [12, 4]);
	assert.ok(h.calls.every(c => c.target === "connection"));
	assert.deepEqual(h.events, ["acquire", "begin", "commit", "release"]);
});

test("forward relation connect verifies tenant and supplies its mapped foreign key", async () => {
	const h = harness(sql => {
		if (sql.includes("FROM `wpp_runtime_contacts`")) return [{ id: 12, instance: "tenant-a" }];
		if (sql.includes("FROM `wpp_runtime_chats`")) return [{ id: 4, instance: "tenant-a", contactId: 12 }];
		return { insertId: 4, affectedRows: 1 };
	});
	const row = await h.client["wppChat"].create({ data: { type: "RECEPTIVE", contact: { connect: { id: 12 } } }, include: { contact: true } });
	const insertion = h.calls.find(c => c.sql.startsWith("INSERT"))!;
	assert.match(insertion.sql, /`contact_id`/);
	assert.ok(insertion.values.includes(12));
	assert.equal(row.contact.id, 12);
	assert.ok(h.calls.filter(c => c.sql.includes("FROM `wpp_runtime_contacts`")).every(c => c.values.includes("tenant-a")));
});

test("implicit many-to-many connect and include use the mapped join table", async () => {
	const h = harness(sql => {
		if (sql.includes("FROM `wpp_runtime_clients`")) return [{ id: 1, instance: "tenant-a" }];
		if (sql.includes("FROM `wpp_runtime_sectors`")) return [{ id: 2, instance: "tenant-a" }];
		if (sql.startsWith("SELECT 1")) return [];
		if (sql.includes("AS id FROM `wpp_runtime__sector_clients`")) return [{ id: 2 }];
		return { affectedRows: 1 };
	});
	const row = await h.client["wppClient"].update({ where: { id: 1 }, data: { sectors: { connect: { id: 2 } } }, include: { sectors: { select: { id: true } } } });
	const insert = h.calls.find(c => c.sql.startsWith("INSERT INTO `wpp_runtime__sector_clients`"))!;
	assert.deepEqual(insert.values, [1, 2]);
	assert.deepEqual(row.sectors, [{ id: 2 }]);
});

test("groupBy and aggregate emit actual SQL max/count and preserve null/date results", async () => {
	const h = harness(sql => sql.includes("GROUP BY") ? [{ contactId: 2, a0: 3, a1: 20 }] : [{ a0: 3, a1: "2026-10-13 10:20:30.000" }]);
	const groups = await h.client["wppMessage"].groupBy({ by: ["contactId"], _count: { id: true }, _max: { id: true }, orderBy: { _count: { id: "desc" } } });
	assert.deepEqual(groups, [{ contactId: 2, _count: { id: 3 }, _max: { id: 20 } }]);
	assert.match(h.calls[0]!.sql, /COUNT\(`id`\).*MAX\(`id`\)/);
	assert.match(h.calls[0]!.sql, /GROUP BY `contact_id` ORDER BY COUNT\(`id`\) DESC/);
	const result = await h.client["wppMessage"].aggregate({ _count: { id: true }, _max: { sentAt: true } });
	assert.equal(result._max.sentAt.toISOString(), "2026-10-13T10:20:30.000Z");
});

test("nullable sector parameters retain global rows while requiring tenant writes", async () => {
	const h = harness();
	await h.client["parameter"].findMany({ where: { sectorId: 4 } });
	assert.match(h.calls[0]!.sql, /`instance` IS NULL/);
	assert.deepEqual(h.calls[0]!.values, [4, "tenant-a"]);
	await assert.rejects(Promise.resolve(h.client["parameter"].create({ data: { instance: "tenant-b" } })), /Tenant mismatch/);
});
