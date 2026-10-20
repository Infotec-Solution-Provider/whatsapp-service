import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Customer } from "../../sdk-local";
import { rewriteRawSql } from "../../tenant-sql/compiler";
import { parseContactAudienceRequest } from "./contract";
import { ContactAudienceReader, type AudienceCustomerMatcher } from "./reader";
import { audienceScanQuery, ContactAudienceRepository, type AudienceExecute } from "./repository";

const input = (contactFilters = {}, customerFilters = {}, pagination: object = { page: 1, perPage: 20 }) =>
	parseContactAudienceRequest({ contactFilters, customerFilters, pagination });

test("DTO rejects unknown fields, mixed pagination, unsafe numbers and oversized manual batches", () => {
	for (const body of [null, [], {}, { ...input(), instance: "other" },
		{ ...input(), contactFilters: { profileLevel: "consolidado" } },
		{ ...input(), contactFilters: { id: "1" } }, { ...input(), contactFilters: { hasCustomer: "false" } },
		{ ...input(), contactFilters: { ids: Array.from({ length: 101 }, (_, id) => id + 1) } },
		{ ...input(), contactFilters: { ids: [0] } }, { ...input(), customerFilters: { instance: "other" } },
		{ ...input(), customerFilters: { page: "1" } }, { ...input(), customerFilters: { sortBy: "CODIGO" } },
		{ ...input(), customerFilters: { CIDADE: 1 } }, { ...input(), customerFilters: { RAZAO: "x".repeat(1501) } },
		{ ...input(), pagination: { page: 1, perPage: 101 } },
		{ ...input(), pagination: { page: 1, perPage: 20, afterId: 0, limit: 20 } },
		{ ...input(), pagination: { page: Number.MAX_SAFE_INTEGER, perPage: 100 } },
		{ ...input(), pagination: { afterId: 0, limit: 201 } },
		{ ...input(), pagination: { afterId: 10, limit: 200, upperId: 9 } }]) {
		assert.throws(() => parseContactAudienceRequest(body));
	}
	assert.deepEqual(input({ ids: [2, 2], sectorIds: [0, -1] }, { RAZAO: "  Cliente ", phone: " " }).contactFilters,
		{ ids: [2], sectorIds: [0, -1] });
	assert.deepEqual(input({}, { RAZAO: "  Cliente ", phone: " " }).customerFilters, { RAZAO: "Cliente" });
});

function fixture(layout: "central" | "tenant") {
	const db = new DatabaseSync(":memory:");
	const contacts = layout === "tenant" ? "wpp_runtime_contacts" : "contacts";
	const sectors = layout === "tenant" ? "wpp_runtime_contacts_sectors" : "contacts_sectors";
	const contactKey = "contactId", sectorKey = "sectorId";
	db.exec(`CREATE TABLE ${contacts} (id INTEGER PRIMARY KEY, instance TEXT, name TEXT, phone TEXT, customer_id INTEGER, is_deleted INTEGER, is_blocked INTEGER, is_only_admin INTEGER, avatar_url TEXT, created_at TEXT, updated_at TEXT, conversation_expiration TEXT, last_out_of_hours_reply_sent_at TEXT);
		CREATE TABLE ${sectors} (${contactKey} INTEGER, ${sectorKey} INTEGER);`);
	const customerIds = new Map<number, number>();
	for (let id = 1; id <= 245; id++) {
		const customerId = id === 100 ? 0 : id === 101 ? -1 : id;
		customerIds.set(id, customerId);
		const name = id === 2 ? "João 50%_!" : `Contato ${id}`;
		db.prepare(`INSERT INTO ${contacts} (id,instance,name,phone,customer_id,is_deleted,is_blocked,is_only_admin,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
			.run(id, "a", name, id % 11 === 0 ? null : `5511999${id}`, id === 239 ? null : customerId, 0, id % 7 === 0 ? 1 : 0, 0, "2026-10-19 00:00:00");
		db.prepare(`INSERT INTO ${sectors} VALUES (?,?)`).run(id, id % 2 ? 1 : 2);
	}
	db.prepare(`INSERT INTO ${sectors} VALUES (?,?)`).run(2, 3); // multiple relations must not duplicate a contact
	db.prepare(`INSERT INTO ${contacts} (id,instance,name,phone,is_deleted,is_blocked,is_only_admin) VALUES (246,'a','deleted','55',1,0,0),(301,'b','foreign','55',0,0,0)`).run();
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const execute: AudienceExecute = async <T>(sql: string, values: unknown[]) => {
		calls.push({ sql, values });
		assert.ok(values.length <= 105, "no unbounded IN list may reach SQL");
		const compiled = layout === "tenant" ? rewriteRawSql(sql) : sql;
		return db.prepare(compiled).all(...values as (number | string | null)[]) as T;
	};
	const batches: number[][] = [];
	const matcher: AudienceCustomerMatcher = async (ids, filters) => {
		assert.ok(ids.length <= 100);
		batches.push(ids);
		// This validation represents the authoritative service parser: it must run
		// for an empty candidate set, too. Customer filter syntax is not reimplemented here.
		if (filters["phone"] === "12") throw new Error("Informe pelo menos três dígitos do telefone.");
		return ids.filter(id => filters["campaignIds"] ? id >= 201 : true).map(id => ({ CODIGO: id, RAZAO: `Cliente ${id}` }) as Customer);
	};
	const store = new ContactAudienceRepository(execute);
	return { db, contacts, calls, batches, store, reader: new ContactAudienceReader(store, matcher) };
}

for (const layout of ["central", "tenant"] as const) {
	test(`${layout}: filters precede count/pagination, results are tenant-scoped and counts survive an empty page`, async () => {
		const h = fixture(layout);
		try {
			const response = await h.reader.search("a", input({}, { campaignIds: "1" }));
			assert.ok("summary" in response);
			assert.equal(response.pagination.total, 44); // 201..245, except unlinked239
			assert.equal(response.data.length, 20);
			assert.equal(response.data[0]!.id, 201, "a match after the first two batches must be included");
			assert.equal(response.summary!.total, response.summary!.eligible + response.summary!.blocked + response.summary!.skipped);
			assert.deepEqual(h.batches[0], [], "validate before reading candidates");
			assert.ok(h.batches.length >= 4);
			const emptyPage = await h.reader.search("a", input({}, { campaignIds: "1" }, { page: 99, perPage: 20 }));
			assert.equal(emptyPage.pagination.total, 44);
			assert.deepEqual(emptyPage.data, []);
			assert.ok(h.calls.every(call => call.values.includes("a")), "every SQL read must carry the authenticated tenant");
		} finally { h.db.close(); }
	});
	test(`${layout}: contact filters combine with customer filters; literal search and signed CRM IDs are preserved`, async () => {
		const h = fixture(layout);
		try {
			const named = await h.reader.search("a", input({ name: "João 50%_!", sectorIds: [2, 3] }));
			assert.deepEqual(named.data.map(contact => contact.id), [2]);
			assert.equal(named.data[0]!.name, "João 50%_!");
			assert.deepEqual(named.data[0]!.sectorIds, [2, 3]);
			const signed = await h.reader.search("a", input({ ids: [100, 101] }));
			assert.deepEqual(signed.data.map(contact => contact.customer?.CODIGO), [0, -1]);
			assert.equal(signed.data.length, 2);
			const none = await h.reader.search("a", input({ hasCustomer: false }, { campaignIds: "1" }));
			assert.equal(none.pagination.total, 0);
			const noSelection = await h.reader.search("a", input({ ids: [] }));
			assert.equal(noSelection.pagination.total, 0, "an explicitly empty manual batch must never become all contacts");
		} finally { h.db.close(); }
	});
	test(`${layout}: cursor traverses more than 100 rows, freezes upperId and returns no duplicate or foreign contacts`, async () => {
		const h = fixture(layout);
		try {
			const first = await h.reader.search("a", input({}, {}, { afterId: 0, limit: 200 }));
			assert.equal(first.pagination.upperId, 245);
			assert.equal(first.pagination.nextCursor, 200);
			assert.equal(first.pagination.hasNext, true);
			h.db.prepare(`INSERT INTO ${h.contacts} (id,instance,name,phone,is_deleted,is_blocked,is_only_admin) VALUES (302,'a','new','55',0,0,0)`).run();
			const second = await h.reader.search("a", input({}, {}, { afterId: first.pagination.nextCursor, upperId: first.pagination.upperId, limit: 200 }));
			assert.equal(second.pagination.hasNext, false);
			assert.equal(second.pagination.nextCursor, null);
			assert.deepEqual([...first.data, ...second.data].map(contact => contact.id), Array.from({ length: 245 }, (_, i) => i + 1));
			assert.ok(h.calls.every(call => /^SELECT\b/i.test(call.sql)), "search must never send or mutate anything");
		} finally { h.db.close(); }
	});
	test(`${layout}: invalid customer filters fail even without candidates; missing phones take skipped precedence`, async () => {
		const h = fixture(layout);
		try {
			await assert.rejects(h.reader.search("a", input({ ids: [] }, { phone: "12" })), /três dígitos/);
			assert.equal(h.calls.length, 0, "invalid filters must fail before contact SQL");
			const result = await h.reader.search("a", input({ ids: [7, 11, 77] }));
			assert.deepEqual(result.summary, { total: 3, eligible: 0, blocked: 1, skipped: 2 });
		} finally { h.db.close(); }
	});
}

test("intermediate customer and database failures never return a partial total or page", async () => {
	const h = fixture("central");
	try {
		let batches = 0;
		const broken = new ContactAudienceReader(h.store, async ids => {
			if (++batches === 3) throw new Error("CRM unavailable");
			return ids.map(id => ({ CODIGO: id }) as Customer);
		});
		await assert.rejects(broken.search("a", input()), /CRM unavailable/);
		const brokenStore = { ...h.store, maxId: async () => 245, scan: async () => { throw new Error("SQL unavailable"); }, sectors: async () => new Map<number, number[]>() };
		await assert.rejects(new ContactAudienceReader(brokenStore, async () => []).search("a", input()), /SQL unavailable/);
	} finally { h.db.close(); }
});

test("cursor validates filtered matches beyond the first 100 and does not claim another page without a matching contact", async () => {
	const h = fixture("central");
	try {
		const response = await h.reader.search("a", input({}, { campaignIds: "1" }, { afterId: 0, limit: 44 }));
		assert.equal(response.data.length, 44);
		assert.equal(response.pagination.hasNext, false);
	} finally { h.db.close(); }
});

test("SQL inputs are bound, contact names use literal LIKE semantics, and deadline failure is explicit", async () => {
	const query = audienceScanQuery("a", { name: "%' OR 1=1", ids: [1] }, 0, 10);
	assert.ok(!query.sql.includes("OR 1=1"));
	assert.ok(query.values.includes("%!%' OR 1=1%"));
	const h = fixture("central");
	try {
		let clock = 0;
		const reader = new ContactAudienceReader(h.store, async () => { clock += 55_001; return []; }, () => clock);
		await assert.rejects(reader.search("a", input()), /deadline/);
	} finally { h.db.close(); }
});
