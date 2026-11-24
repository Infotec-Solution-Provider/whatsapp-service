import assert from "node:assert/strict";
import test from "node:test";
import {
	parseMetaPhoto,
	parseMetaProfilePatch,
	parseMetaTemplateFilters,
	parseMetaTemplateInput,
} from "./meta-management.validation";

const template = {
	name: "lembrete_agendamento",
	language: "pt_BR",
	category: "UTILITY",
	body: "Olá, {{1}}. Seu atendimento está marcado para {{2}}.",
	examples: ["Maria", "segunda-feira"],
};

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("accepts a utility template with sequential placeholders and examples", () => {
	assert.deepEqual(parseMetaTemplateInput(template), template);
	const plain = { ...template, body: "Seu pedido foi concluído.", examples: [] };
	assert.deepEqual(parseMetaTemplateInput(plain), plain);
});

test("rejects category, name, placeholders and examples outside the text template contract", () => {
	for (const input of [
		{ ...template, name: "Lembrete de agendamento" },
		{ ...template, category: "AUTHENTICATION" },
		{ ...template, body: "Olá, {{1}}. Atendimento previsto para {{3}}." },
		{ ...template, body: "Olá, {{nome}}. Confira seu atendimento.", examples: ["Maria"] },
		{ ...template, body: "Olá, {{ 1 }}. Confira seu atendimento.", examples: ["Maria"] },
		{ ...template, examples: ["Maria"] },
		{ ...template, examples: ["Maria", ""] },
		{ ...template, body: "x".repeat(1_025), examples: [] },
	]) {
		assert.throws(() => parseMetaTemplateInput(input));
	}
});

test("preserves opaque pagination cursors while validating request filter types", () => {
	const filters = { after: "Opaque+cursor==", language: "pt_BR", status: "APPROVED" };
	const parsed = parseMetaTemplateFilters(filters);
	assert.equal(parsed.after, filters.after);
	assert.equal(parsed.language, filters.language);
	assert.equal(parsed.status, filters.status);
	assert.throws(() => parseMetaTemplateFilters({ after: ["one", "two"] }));
	assert.throws(() => parseMetaTemplateFilters({ status: "pending review" }));
});

test("preserves a partial profile patch and normalizes clear operations", () => {
	assert.deepEqual(parseMetaProfilePatch({
		description: null, websites: [], about: "Atendimento oficial",
	}), { description: "", websites: [], about: "Atendimento oficial" });
	assert.deepEqual(parseMetaProfilePatch({ address: "Av. Paulista" }), { address: "Av. Paulista" });
});

test("rejects invalid public contact information and values outside profile field limits", () => {
	for (const input of [
		{ email: "malformed" },
		{ websites: ["ftp://example.com"] },
		{ websites: ["https://example.org", "https://example.net", "https://example.com"] },
		{ about: "a".repeat(140) },
		{ address: "a".repeat(257) },
		{ description: "a".repeat(257) },
		{ vertical: "NOT_A_BIZ" },
	]) {
		assert.throws(() => parseMetaProfilePatch(input));
	}
});

test("requires a supported image signature and limits profile photo uploads to five mebibytes", () => {
	const png = Buffer.concat([pngSignature, Buffer.alloc(20)]);
	const valid = parseMetaPhoto({ buffer: png, mimetype: "image/png" });
	assert.deepEqual(valid.bytes, png);
	assert.equal(valid.contentType, "image/png");
	assert.throws(() => parseMetaPhoto({ buffer: png, mimetype: "image/jpeg" }));
	assert.throws(() => parseMetaPhoto({ buffer: Buffer.from("profile-image.svg"), mimetype: "image/png" }));
	const tooLarge = Buffer.alloc(5 * 1_024 * 1_024 + 1);
	pngSignature.copy(tooLarge);
	assert.throws(() => parseMetaPhoto({ buffer: tooLarge, mimetype: "image/png" }));
});
