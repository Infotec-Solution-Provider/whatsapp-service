import assert from "node:assert/strict";
import type { WppContact } from "@prisma/client";
import { buildContactCustomerResolutionQuery, ContactCustomerResolutionService, customerResolutionPhone } from "./contact-customer-resolution.service";
import { OdimLiveCopyWriter } from "./odim-live-copy.core";

const scope = { instance: "tenant-a", sectorId: 17 };
function fixture(initial: Partial<WppContact> = {}, matches: Array<{ customer_id: number | string }> = [{ customer_id: 42 }]) {
	const row = { id: 8, instance: "tenant-a", customerId: null, isDeleted: false, phone: "5511987654321", whatsappId: "5511987654321", name: "Manual", ...initial } as WppContact;
	const counts = { lookup: 0, writes: 0, syncs: 0 };
	let queryError = false, syncError = false;
	let afterQuery = () => {}, beforeWrite = () => {};
	const resolver = new ContactCustomerResolutionService({
		sectorBelongsToInstance: async (instance, sector) => instance === "tenant-a" && sector === 17,
		getContact: async (instance, id) => row.instance === instance && row.id === id ? { ...row } : null,
		query: async (instance, _sql, _params) => { assert.equal(instance, "tenant-a"); counts.lookup++; afterQuery(); if (queryError) throw Error("database host / private input must not escape"); return matches; },
		linkIfUnchanged: async (old, id) => {
			beforeWrite();
			if (row.customerId !== old.customerId || row.phone !== old.phone || row.whatsappId !== old.whatsappId || row.isDeleted) return 0;
			counts.writes++; row.customerId = id; return 1;
		},
		syncContact: async contact => { counts.syncs++; assert.equal(contact.customerId, row.customerId); if (syncError) throw Error("sync down"); }
	});
	return { row, counts, resolver, failQuery: () => { queryError = true; }, failSync: () => { syncError = true; }, afterQuery: (fn: () => void) => { afterQuery = fn; }, race: (fn: () => void) => { beforeWrite = fn; } };
}

async function main() {
	assert.deepEqual(customerResolutionPhone("+55 (11) 98765-4321")?.local, ["987654321", "87654321"]);
	assert.deepEqual(customerResolutionPhone("1187654321")?.full, ["1187654321", "551187654321", "11987654321", "5511987654321"]);
	assert.deepEqual(customerResolutionPhone("1132654321")?.local, ["32654321"], "fixed lines do not gain a ninth digit");
	assert.equal(customerResolutionPhone("87654321"), null, "no suffix-only identity");
	assert.equal(customerResolutionPhone("+1 202 555 0123 99"), null);
	const query = buildContactCustomerResolutionQuery("5511987654321")!;
	assert.ok(!query.sql.includes("5511987654321"), "phone values are parameters");
	assert.match(query.sql, /clientes c.+UNION ALL.+contatos ct/);
	assert.match(query.sql, /^SELECT DISTINCT candidate.customer_id.+LIMIT 2$/);
	assert.equal((query.sql.match(/LIMIT/g) || []).length, 1, "deduplicate identities before limiting candidates");
	assert.equal((query.sql.match(/\?/g) || []).length, query.params.length);
	for (const customerId of [null, 0, -1]) {
		const f = fixture({ customerId });
		const result = await f.resolver.resolve(scope, f.row);
		assert.deepEqual(result.resolution, { status: "found", customerId: 42, reason: "linked" });
		assert.equal(result.contact.name, "Manual");
		assert.deepEqual(f.counts, { lookup: 1, writes: 1, syncs: 1 });
		await f.resolver.resolve(scope, f.row);
		assert.equal(f.counts.lookup, 1, "positive links skip CRM lookups on a subsequent creation");
	}
	const same = fixture({}, [{ customer_id: 42 }, { customer_id: "42" }]);
	assert.equal((await same.resolver.resolve(scope, same.row)).resolution.status, "found");
	for (const [matches, status] of [[[], "not_found"], [[{ customer_id: 42 }, { customer_id: 43 }], "ambiguous"], [[{ customer_id: 0 }], "unavailable"]] as const) {
		const f = fixture({}, [...matches]);
		assert.equal((await f.resolver.resolve(scope, f.row)).resolution.status, status);
		assert.equal(f.counts.writes, 0);
	}
	const unavailable = fixture(); unavailable.failQuery();
	assert.deepEqual((await unavailable.resolver.resolve(scope, unavailable.row)).resolution, { status: "unavailable", reason: "lookup_unavailable" });
	assert.equal(unavailable.counts.writes, 0);
	const already = fixture({ customerId: 99 });
	assert.deepEqual((await already.resolver.resolve(scope, already.row)).resolution, { status: "found", customerId: 99, reason: "already_linked" });
	assert.equal(already.counts.lookup, 0);
	for (const matches of [[], [{ customer_id: 42 }, { customer_id: 43 }], [{ customer_id: 42 }]]) {
		const f = fixture({}, matches); f.afterQuery(() => { f.row.customerId = 99; });
		assert.deepEqual((await f.resolver.resolve(scope, f.row)).resolution, { status: "found", customerId: 99, reason: "concurrent_link" });
		assert.equal(f.counts.writes, 0);
	}
	const raced = fixture(); raced.race(() => { raced.row.customerId = 99; });
	assert.equal((await raced.resolver.resolve(scope, raced.row)).contact.customerId, 99);
	assert.equal(raced.counts.syncs, 0, "do not synchronize an overwritten snapshot");
	const addressChanged = fixture(); addressChanged.race(() => { addressChanged.row.phone = "5511999999999"; });
	assert.equal((await addressChanged.resolver.resolve(scope, addressChanged.row)).resolution.status, "unavailable");
	assert.equal(addressChanged.row.customerId, null);
	const pending = fixture(); pending.failSync();
	assert.deepEqual((await pending.resolver.resolve(scope, pending.row)).resolution, { status: "found", customerId: 42, reason: "sync_pending" });
	assert.equal(pending.row.customerId, 42, "mirror failure does not roll back a central link");
	for (const change of [{ instance: "other" }, { sectorId: 18 }]) {
		const f = fixture();
		await assert.rejects(() => f.resolver.resolve({ ...scope, ...change }, f.row), /SCOPE_MISMATCH/);
		assert.equal(f.counts.lookup, 0);
	}
	const invalidPhone = fixture({ phone: null });
	assert.equal((await invalidPhone.resolver.resolve(scope, invalidPhone.row)).resolution.status, "unavailable");
	assert.equal(invalidPhone.counts.lookup, 0);

	// A legacy row with no customer must adopt the exact identity without undoing a new link.
	const newlyLinked = fixture();
	await newlyLinked.resolver.resolve(scope, newlyLinked.row);
	const calls: string[] = [];
	const db = { execute: async (sql: string) => {
		calls.push(sql);
		if (sql.includes("SELECT target_id")) return [[]];
		if (sql.includes("SELECT id,customer_id")) return [[{ id: 8, customer_id: newlyLinked.row.customerId }]];
		if (sql.includes("SELECT id FROM contacts")) return [[{ id: 8 }]];
		return [{ affectedRows: 1 }];
	} };
	const writer = new OdimLiveCopyWriter(db, { preserveCurrentOperations: true });
	for (const legacy of [null, 0, -1]) assert.equal(await writer.contact({ CODIGO: 1, NUMERO: "5511987654321", IDENTIFICADOR: "5511987654321", CODIGO_CLIENTE: legacy }), 8);
	assert.ok(!calls.some(sql => /UPDATE contacts|INSERT INTO contacts/.test(sql)), "copy preserves the newly linked identity");
	console.log("contact customer resolution: normalization, 4 states, isolation, CAS races and live-copy preservation passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
