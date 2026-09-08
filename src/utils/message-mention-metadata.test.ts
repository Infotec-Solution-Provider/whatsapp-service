import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { mentionMetadataToPrisma, normalizeMentionDisplayName, normalizeMentionEntities } from "./message-mention-metadata";

const cases: Array<[string, () => void]> = [];
const test = (name: string, run: () => void) => cases.push([name, run]);

test("numeric LID is never inferred as a phone", () => {
	const [lid] = normalizeMentionEntities([{ id: "551199999999@lid", type: "lid" }]);
	assert.equal(lid!.phone, null);
	assert.deepEqual(lid!.tokens, ["@551199999999", "@551199999999@lid"]);
	assert.equal(lid!.type, "lid");
});

test("phone/device JID normalizes but keeps a supplied literal transport token", () => {
	const [phone] = normalizeMentionEntities([{ id: "551199999999:2@c.us", tokens: ["@551199999999:2@c.us"] }]);
	assert.equal(phone!.id, "551199999999@s.whatsapp.net");
	assert.equal(phone!.phone, "551199999999");
	assert.ok(phone!.tokens.includes("@551199999999:2@c.us"));
	assert.ok(phone!.tokens.includes("@551199999999@c.us"));
});

test("only an explicit valid phone mapping adds PN aliases to a LID", () => {
	const [mapped] = normalizeMentionEntities([{ id: "123456@lid", phone: "+55 (11) 9999-9999" }]);
	assert.equal(mapped!.phone, "551199999999");
	assert.ok(mapped!.tokens.includes("@551199999999"));
	assert.ok(mapped!.tokens.includes("@123456@lid"));
	for (const phone of [null, "551199999999@lid", "text551199999999", "123"]) {
		const [invalid] = normalizeMentionEntities([{ id: "123456@lid", phone }]);
		assert.equal(invalid!.phone, null);
		assert.ok(!invalid!.tokens.includes("@551199999999"));
	}
});

test("a phone identity retains only an explicitly confirmed LID alias", () => {
	const [phone] = normalizeMentionEntities([{ id: "551199999999@s.whatsapp.net", lid: "123456@lid", tokens: ["@123456", "@~123456"] }]);
	assert.equal(phone!.lid, "123456");
	assert.ok(phone!.tokens.includes("@123456"));
	assert.ok(phone!.tokens.includes("@123456@lid"));
	assert.ok(phone!.tokens.includes("@~123456"));
	assert.equal(normalizeMentionEntities([{ id: "551199999999@s.whatsapp.net" }])[0]!.lid, null);
	const [conflict] = normalizeMentionEntities([
		{ id: "551199999999@s.whatsapp.net", lid: "123456" },
		{ id: "551199999999@s.whatsapp.net", lid: "999999" },
		{ id: "551199999999@s.whatsapp.net", lid: "123456" },
	]);
	assert.equal(conflict!.lid, null);
	assert.ok(!conflict!.tokens.includes("@123456"));
});

test("user IDs require explicit user type and keep their own token namespace", () => {
	const [user] = normalizeMentionEntities([{ id: "7", type: "user", tokens: ["@7", "@~999"], phone: "551199999999" }]);
	assert.equal(user!.id, "user:7");
	assert.equal(user!.phone, null);
	assert.deepEqual(user!.tokens, ["@~7"]);
	assert.deepEqual(normalizeMentionEntities([{ id: "7" }, { id: "user:7", type: "lid" }]), []);
});

test("legacy @~ provider token is accepted only with explicit matching identity metadata", () => {
	const [entity] = normalizeMentionEntities([{ id: "123456@lid", tokens: ["@~123456", "@~999999", "@~551199999999"] }]);
	assert.ok(entity!.tokens.includes("@~123456"));
	assert.ok(!entity!.tokens.includes("@~999999"));
	assert.ok(!entity!.tokens.includes("@~551199999999"));
	assert.ok(!normalizeMentionEntities([{ id: "123456@lid" }])[0]!.tokens.includes("@~123456"));
});

test("malformed entities, group IDs and unsupported namespaces are rejected without throwing", () => {
	assert.deepEqual(normalizeMentionEntities(null), []);
	assert.deepEqual(normalizeMentionEntities({ id: "123456@lid" }), []);
	assert.deepEqual(normalizeMentionEntities([null, false, [], { id: "123456@g.us" }, { id: "status@broadcast" }, { id: "123456@lid", type: "phone" }]), []);
	assert.equal(normalizeMentionEntities(Array.from({ length: 250 }, (_, i) => ({ id: `${i + 1}@lid` }))).length, 200);
});

test("identity strings and numeric fallbacks are not accepted as display names", () => {
	for (const displayName of ["551199999999", "+55 (11) 9999-9999", "123456@lid", "@~7", "undefined", " Alice\nSecret "]) {
		assert.equal(normalizeMentionEntities([{ id: "123456@lid", displayName }])[0]!.displayName, null);
	}
	assert.equal(normalizeMentionDisplayName(" Alice Comercial "), "Alice Comercial");
	assert.equal(Array.from(normalizeMentionDisplayName("🙂".repeat(200))!).length, 191);
});

test("duplicate identities merge valid data and conflicting phone mappings remain discarded", () => {
	const normalized = normalizeMentionEntities([
		{ id: "123456@lid", phone: "551199999999", displayName: null },
		{ id: "123456@lid", phone: "551188888888", displayName: "Alice" },
		{ id: "123456@lid", phone: "551199999999" },
	]);
	assert.equal(normalized.length, 1);
	assert.equal(normalized[0]!.phone, null);
	assert.equal(normalized[0]!.displayName, "Alice");
	assert.ok(!normalized[0]!.tokens.some((token) => token.includes("5511")));
});

test("Prisma metadata distinguishes legacy null from an explicit empty mention list", () => {
	assert.equal(mentionMetadataToPrisma(null), Prisma.DbNull);
	assert.equal(mentionMetadataToPrisma(undefined), Prisma.DbNull);
	assert.deepEqual(mentionMetadataToPrisma([]), []);
	const raw = Object.freeze([Object.freeze({ id: "123456@lid", tokens: Object.freeze(["@123456"]) })]);
	const before = JSON.stringify(raw);
	assert.equal(normalizeMentionEntities(raw).length, 1);
	assert.equal(JSON.stringify(raw), before);
});

for (const [name, run] of cases) { run(); console.log(`PASS ${name}`); }
console.log(`${cases.length} mention metadata tests passed.`);
