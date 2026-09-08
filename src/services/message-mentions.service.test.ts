import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { MessageMentionsService } from "./message-mentions.service";

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "OR") return (value as Row[]).some((branch) => matches(row, branch));
		if (value !== null && typeof value === "object") {
			if ("in" in value) return value.in.includes(row[key]);
			if ("some" in value) return Array.isArray(row[key]) && row[key].some((item: Row) => matches(item, value.some));
			throw new Error(`Unsupported predicate ${key}`);
		}
		return row[key] === value;
	});
}

function fixture() {
	const contacts: Row[] = [];
	const senders: Row[] = [];
	const queries: Array<{ table: string; where: Row }> = [];
	const fault = { table: null as "contacts" | "senders" | null };
	const db = {
		wppContact: { findMany: async ({ where }: { where: Row }) => {
			queries.push({ table: "contacts", where });
			if (fault.table === "contacts") throw new Error("simulated contacts query failure");
			return structuredClone(contacts.filter((contact) => matches(contact, where)));
		} },
		internalWhatsappSender: { findMany: async ({ where, select }: { where: Row; select: Row }) => {
			queries.push({ table: "senders", where });
			if (fault.table === "senders") throw new Error("simulated scoped sender query failure");
			return senders.filter((sender) => matches(sender, where)).map((sender) => ({
				...structuredClone(sender), messages: sender["messages"].filter((message: Row) => matches(message, select["messages"].where)),
			}));
		} },
	};
	return { service: new MessageMentionsService(db as unknown as PrismaClient), contacts, senders, queries, fault };
}

function message(overrides: Row = {}) {
	return { id: 1, instance: "tenant-a", body: "Oi @123456! Texto original.\n🙂", mentionMetadata: [{ id: "123456@lid", displayName: "Nome do provedor" }], ...overrides };
}

function contact(overrides: Row = {}): Row {
	return { id: 1, instance: "tenant-a", whatsappId: "123456@lid", phone: null, name: "Nome do contato", isDeleted: false, ...overrides };
}

function sender(overrides: Row = {}): Row {
	return { instance: "tenant-a", senderId: "123456@lid", displayName: "Nome manual", isManuallyNamed: true,
		messages: [{ instance: "tenant-a", internalChatId: 10 }], ...overrides };
}

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);

test("manual names only resolve in their authorized internal group, never WPP/other groups", async () => {
	const f = fixture(); f.contacts.push(contact()); f.senders.push(sender());
	const hydrated = await f.service.hydrate("tenant-a", [message(), message({ id: 2, internalChatId: 10 }), message({ id: 3, internalChatId: 20 })]);
	assert.deepEqual(hydrated.map((item) => item.mentionEntities![0]!.displayName), ["Nome do contato", "Nome manual", "Nome do contato"]);
	const senderQuery = f.queries.find((query) => query.table === "senders")!.where;
	assert.equal(senderQuery["instance"], "tenant-a");
	assert.deepEqual(senderQuery["messages"].some, { instance: "tenant-a", internalChatId: { in: [10, 20] } });
});

test("names from other tenants or private groups cannot enrich the current message", async () => {
	const f = fixture();
	f.contacts.push(contact({ instance: "tenant-b", name: "Other tenant" }));
	f.senders.push(sender({ messages: [{ instance: "tenant-a", internalChatId: 99 }], displayName: "Private group" }));
	const [hydrated] = await f.service.hydrate("tenant-a", [message({ internalChatId: 10 })]);
	assert.equal(hydrated!.mentionEntities![0]!.displayName, "Nome do provedor");
	assert.ok(f.queries.every((query) => query.where["instance"] === "tenant-a"));
	const [foreign] = await f.service.hydrate("tenant-a", [message({ instance: "tenant-b" })]);
	assert.deepEqual(foreign!.mentionEntities, []);
});

test("name priority is manual, contact, learned sender and sanitized provider fallback", async () => {
	const f = fixture(); f.contacts.push(contact()); f.senders.push(sender());
	const lookup = async () => (await f.service.hydrate("tenant-a", [message({ internalChatId: 10 })]))[0]!.mentionEntities![0]!.displayName;
	assert.equal(await lookup(), "Nome manual");
	f.senders[0]!["isManuallyNamed"] = false;
	assert.equal(await lookup(), "Nome do contato");
	f.contacts[0]!["name"] = "123456@lid";
	assert.equal(await lookup(), "Nome manual");
	f.senders[0]!["displayName"] = null;
	assert.equal(await lookup(), "Nome do provedor");
});

test("reload reflects renamed contacts without altering raw body or persisted metadata", async () => {
	const f = fixture(); f.contacts.push(contact());
	const raw = message(); const before = JSON.stringify(raw);
	const [first] = await f.service.hydrate("tenant-a", [raw]);
	f.contacts[0]!["name"] = "Novo nome";
	const [second] = await f.service.hydrate("tenant-a", [raw]);
	assert.equal(first!.mentionEntities![0]!.displayName, "Nome do contato");
	assert.equal(second!.mentionEntities![0]!.displayName, "Novo nome");
	assert.equal(second!.body, raw.body);
	assert.equal(JSON.stringify(raw), before);
});

test("a phone-shaped LID never queries the corresponding phone contact or invents PN aliases", async () => {
	const f = fixture(); f.contacts.push(contact({ whatsappId: "551199999999@s.whatsapp.net", phone: "551199999999", name: "Unrelated telephone" }));
	const [hydrated] = await f.service.hydrate("tenant-a", [message({ mentionMetadata: [{ id: "551199999999@lid" }] })]);
	const entity = hydrated!.mentionEntities![0]!;
	assert.equal(entity.phone, null);
	assert.equal(entity.displayName, null);
	assert.ok(!entity.tokens.some((token) => token.includes("s.whatsapp.net")));
	assert.ok(f.queries.every((query) => !JSON.stringify(query.where).includes('"phone"')));
});

test("an exact contact LID mapping supplies a confirmed phone and scoped manual sender alias", async () => {
	const f = fixture(); f.contacts.push(contact({ phone: "551188888888" }));
	f.senders.push(sender({ senderId: "551188888888@c.us", displayName: "Manual por telefone" }));
	const [hydrated] = await f.service.hydrate("tenant-a", [message({ internalChatId: 10 })]);
	const entity = hydrated!.mentionEntities![0]!;
	assert.equal(entity.id, "123456@lid");
	assert.equal(entity.phone, "551188888888");
	assert.equal(entity.displayName, "Manual por telefone");
	assert.ok(entity.tokens.includes("@551188888888"));
});

test("historical bare sender IDs are compatible but do not establish a phone mapping", async () => {
	const f = fixture(); f.senders.push(sender({ senderId: "123456" }));
	const [hydrated] = await f.service.hydrate("tenant-a", [message({ internalChatId: 10 })]);
	assert.equal(hydrated!.mentionEntities![0]!.displayName, "Nome manual");
	assert.equal(hydrated!.mentionEntities![0]!.phone, null);
	assert.ok(!hydrated!.mentionEntities![0]!.tokens.some((token) => token.includes("s.whatsapp.net")));
});

test("legacy bare LID contacts resolve conservatively without matching PN-shaped bare contacts", async () => {
	const f = fixture(); f.contacts.push(contact({ whatsappId: "123456" }));
	const [legacy] = await f.service.hydrate("tenant-a", [message()]);
	assert.equal(legacy!.mentionEntities![0]!.displayName, "Nome do contato");
	assert.equal(legacy!.mentionEntities![0]!.phone, null);
	f.contacts[0]!["phone"] = "123456";
	const [ambiguous] = await f.service.hydrate("tenant-a", [message()]);
	assert.equal(ambiguous!.mentionEntities![0]!.displayName, "Nome do provedor");
	f.contacts[0]!["phone"] = null;
	const [both] = await f.service.hydrate("tenant-a", [message({ mentionMetadata: [{ id: "123456@lid" }, { id: "123456@s.whatsapp.net" }] })]);
	assert.deepEqual(both!.mentionEntities!.map((entity) => entity.displayName), [null, null]);
});

test("an explicit contact LID/phone mapping enriches the PN entity with a confirmed LID alias", async () => {
	const f = fixture(); f.contacts.push(contact({ phone: "551199999999" }));
	const [hydrated] = await f.service.hydrate("tenant-a", [message({ mentionMetadata: [{ id: "551199999999@s.whatsapp.net" }] })]);
	const entity = hydrated!.mentionEntities![0]!;
	assert.equal(entity.lid, "123456");
	assert.equal(entity.phone, "551199999999");
	assert.ok(entity.tokens.includes("@123456"));
});

test("conflicting aliases across messages never transfer a contact name to an unmapped LID", async () => {
	const f = fixture();
	f.contacts.push(contact({ id: 1, whatsappId: "551199999999@s.whatsapp.net", phone: "551199999999", name: "Phone A" }));
	f.contacts.push(contact({ id: 2, whatsappId: "551188888888@s.whatsapp.net", phone: "551188888888", name: "Phone B" }));
	const hydrated = await f.service.hydrate("tenant-a", [
		message({ mentionMetadata: [{ id: "123456@lid", phone: "551199999999" }] }),
		message({ mentionMetadata: [{ id: "123456@lid", phone: "551188888888" }] }),
		message({ mentionMetadata: [{ id: "123456@lid" }] }),
	]);
	assert.deepEqual(hydrated.map((item) => item.mentionEntities![0]!.displayName), ["Phone A", "Phone B", null]);
});

test("an ambiguous bare sender cannot join a phone and LID with equal numeric identifiers", async () => {
	const f = fixture(); f.senders.push(sender({ senderId: "551199999999", displayName: "Ambiguous private alias" }));
	const [hydrated] = await f.service.hydrate("tenant-a", [message({ internalChatId: 10, mentionMetadata: [
		{ id: "551199999999@lid" }, { id: "551199999999@s.whatsapp.net" },
	] })]);
	assert.deepEqual(hydrated!.mentionEntities!.map((entity) => entity.displayName), [null, null]);
	const ids = f.queries.find((query) => query.table === "senders")!.where["senderId"].in;
	assert.ok(!ids.includes("551199999999"));
});

test("legacy null stays absent, explicit empty metadata stays empty, and DTO-only metadata is preserved", async () => {
	const f = fixture();
	const hydrated = await f.service.hydrate("tenant-a", [
		message({ mentionMetadata: null }), message({ mentionMetadata: null, mentionEntities: null }),
		message({ mentionMetadata: [], mentionEntities: [{ id: "123456@lid" }] }),
		message({ mentionMetadata: null, mentionEntities: [{ id: "user:7", type: "user" }] }),
		message({ mentionMetadata: { invalid: true } }),
	]);
	assert.ok(!Object.hasOwn(hydrated[0]!, "mentionEntities"));
	assert.ok(!Object.hasOwn(hydrated[1]!, "mentionEntities"));
	assert.deepEqual(hydrated[2]!.mentionEntities, []);
	assert.equal(hydrated[3]!.mentionEntities![0]!.id, "user:7");
	assert.deepEqual(hydrated[4]!.mentionEntities, []);
	assert.equal(f.queries.length, 0, "internal users resolve in existing frontend directory, never via a new backend API");
});

test("same identity does not copy token spellings or optional phone aliases between messages", async () => {
	const f = fixture();
	const hydrated = await f.service.hydrate("tenant-a", [
		message({ mentionMetadata: [{ id: "123456@lid", tokens: ["@~123456"], phone: "551199999999" }] }),
		message({ mentionMetadata: [{ id: "123456@lid" }] }),
	]);
	assert.ok(hydrated[0]!.mentionEntities![0]!.tokens.includes("@~123456"));
	assert.ok(!hydrated[1]!.mentionEntities![0]!.tokens.includes("@~123456"));
	assert.equal(hydrated[1]!.mentionEntities![0]!.phone, null);
});

test("bulk history resolves in batches, not once per message, with a 500-message guard", async () => {
	const f = fixture(); f.contacts.push(contact()); f.senders.push(sender());
	const messages = Array.from({ length: 200 }, (_, id) => message({ id, internalChatId: 10 }));
	await f.service.hydrate("tenant-a", messages);
	assert.equal(f.queries.length, 2);
	f.queries.length = 0;
	const large = Array.from({ length: 501 }, (_, id) => message({ id, internalChatId: 10 }));
	assert.equal((await f.service.hydrate("tenant-a", large)).length, 501);
	assert.equal(f.queries.length, 4);
});

test("lookup outages preserve typed stored metadata, legacy absence, tenant isolation and original body", async () => {
	for (const table of ["contacts", "senders"] as const) {
		const f = fixture(); f.contacts.push(contact()); f.senders.push(sender()); f.fault.table = table;
		const raw = message({ internalChatId: 10 }); const before = JSON.stringify(raw);
		const hydrated = await f.service.hydrate("tenant-a", [raw, message({ mentionMetadata: null }), message({ instance: "tenant-b" })]);
		assert.equal(hydrated[0]!.body, raw.body);
		assert.equal(hydrated[0]!.mentionEntities![0]!.displayName, "Nome do provedor");
		assert.equal(hydrated[0]!.mentionEntities![0]!.id, "123456@lid");
		assert.equal(hydrated[0]!.mentionEntities![0]!.phone, null);
		assert.ok(!Object.hasOwn(hydrated[1]!, "mentionEntities"));
		assert.deepEqual(hydrated[2]!.mentionEntities, []);
		assert.equal(JSON.stringify(raw), before);
	}
});

async function run(): Promise<void> {
	for (const [name, execute] of tests) { await execute(); console.log(`PASS ${name}`); }
	console.log(`${tests.length} mention hydration tests passed (isolated; no live database).`);
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });
