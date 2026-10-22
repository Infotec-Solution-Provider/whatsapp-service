import assert from "node:assert/strict";
import type { WppContact } from "@prisma/client";
import { ContactCustomerLinkService } from "./contact-customer-link.service";
import { buildCustomerPhoneLookup, phoneLookupAlternatives, suggestCustomersByPhone } from "./contact-customer-suggestions.service";

const customer = (id: number) => ({ id, name: `Cliente ${id}`, cpfCnpj: null, erpCode: null });
function fixture(overrides: Partial<WppContact> = {}) {
	const row = { id: 8, instance: "tenant-a", customerId: null, isDeleted: false, name: "Contato", phone: "5511987654321", ...overrides } as WppContact;
	let writes = 0, syncs = 0, customerReads = 0;
	let beforeWrite: (() => void) | null = null;
	let customerExists = true;
	let failSync = false;
	const service = new ContactCustomerLinkService({
		getContact: async (instance, id) => instance === row.instance && id === row.id ? { ...row } : null,
		getCustomer: async (id) => { customerReads++; return customerExists ? customer(id) : null; },
		linkIfUnlinked: async (instance, id, customerId) => {
			beforeWrite?.();
			if (row.instance !== instance || row.id !== id || ![null, 0, -1].includes(row.customerId) || row.isDeleted) return 0;
			writes++; row.customerId = customerId; return 1;
		},
		syncContact: async () => { syncs++; if (failSync) throw new Error("CRM sync unavailable"); }
	});
	return { row, service, counts: () => ({ writes, syncs, customerReads }), race: (fn: () => void) => { beforeWrite = fn; }, missingCustomer: () => { customerExists = false; }, setSyncFailure: (value: boolean) => { failSync = value; } };
}

async function main() {
	for (const customerId of [0, -1]) {
		const historical = fixture({ customerId });
		await historical.service.link("tenant-a", 8, 12);
		assert.equal(historical.row.customerId, 12);
		assert.equal(historical.counts().writes, 1);
	}
	const normal = fixture();
	await normal.service.link("tenant-a", 8, 12);
	assert.equal(normal.row.customerId, 12);
	assert.equal(normal.row.name, "Contato");
	await normal.service.link("tenant-a", 8, 12);
	assert.equal(normal.counts().writes, 1, "retrying the same confirmation is idempotent");
	assert.equal(normal.counts().syncs, 2, "a retry can repair the existing local mirror");
	const mirror = fixture(); mirror.setSyncFailure(true);
	await assert.rejects(() => mirror.service.link("tenant-a", 8, 12), /sync unavailable/);
	assert.equal(mirror.row.customerId, 12, "saved link survives mirror failure");
	mirror.setSyncFailure(false);
	await mirror.service.link("tenant-a", 8, 12);
	assert.equal(mirror.counts().writes, 1, "repair does not rewrite the link");
	for (const [tenant, contactId, customerId] of [["tenant-b", 8, 12], ["tenant-a", 0, 12], ["tenant-a", 8, -1]] as const) {
		const f = fixture();
		await assert.rejects(() => f.service.link(tenant, contactId, customerId));
		assert.deepEqual(f.counts(), { writes: 0, syncs: 0, customerReads: 0 });
	}
	for (const overrides of [{ isDeleted: true }, { customerId: 99 }]) {
		const f = fixture(overrides);
		await assert.rejects(() => f.service.link("tenant-a", 8, 12));
		assert.equal(f.counts().writes, 0);
	}
	const unavailable = fixture(); unavailable.missingCustomer();
	await assert.rejects(() => unavailable.service.link("tenant-a", 8, 12));
	assert.equal(unavailable.counts().writes, 0);
	const raced = fixture(); raced.race(() => { raced.row.customerId = 99; });
	await assert.rejects(() => raced.service.link("tenant-a", 8, 12), /alterado/);
	assert.equal(raced.row.customerId, 99);
	assert.equal(raced.counts().syncs, 0);

	assert.deepEqual(phoneLookupAlternatives("+55 (11) 98765-4321"), ["11987654321", "5511987654321"]);
	assert.deepEqual(phoneLookupAlternatives("551187654321"), ["1187654321", "551187654321"], "do not insert ninth digit");
	assert.deepEqual(phoneLookupAlternatives("87654321"), [], "no suffix-only matching");
	assert.equal(buildCustomerPhoneLookup(["CODIGO", "unsafe_column"], "5511987654321"), null);
	const query = buildCustomerPhoneLookup(["CODIGO", "FONE1", "AREA1", "unsafe_column"], "5511987654321")!;
	assert.equal(query.params.length, 4);
	assert.ok(!query.sql.includes("unsafe_column"));
	assert.ok(!query.sql.includes("5511987654321"));
	assert.match(query.sql, /LIMIT 11$/);
	let calls = 0;
	const lookup = {
		columns: async () => { calls++; return ["CODIGO", "FONE1"]; },
		query: async () => [{ id: 1 }, { id: 2 }, { id: 2 }],
		getCustomer: async (id: number) => customer(id)
	};
	assert.equal((await suggestCustomersByPhone(false, "5511987654321", lookup)).status, "disabled");
	assert.equal(calls, 0, "disabled lookup makes no CRM request");
	const multiple = await suggestCustomersByPhone(true, "5511987654321", lookup);
	assert.equal(multiple.candidates.length, 2, "duplicate phone is presented as choices, never auto-linked");
	assert.equal(multiple.status, "ready");
	assert.equal((await suggestCustomersByPhone(true, "5511987654321", { ...lookup, columns: async () => [] })).status, "unsupported");
	assert.equal((await suggestCustomersByPhone(true, "5511987654321", { ...lookup, query: async () => { throw new Error("CRM unavailable"); } })).status, "unavailable");
	const restricted = await suggestCustomersByPhone(true, "5511987654321", { ...lookup, getCustomer: async (id) => id === 1 ? customer(id) : null });
	assert.deepEqual(restricted.candidates.map((item) => item.id), [1], "candidate must pass ordinary customer API authorization");
	const truncated = await suggestCustomersByPhone(true, "5511987654321", { ...lookup, query: async () => Array.from({ length: 11 }, (_, i) => ({ id: i + 1 })) });
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.candidates.length, 10);
	console.log("contact customer link: tenant isolation, CAS, retry and phone lookup cases passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
