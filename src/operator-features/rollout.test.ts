import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertOperatorFeature, operatorFeatures, readOperatorFeaturePolicy, requiredWhatsAppFeature, whatsappEligibleIds, OperatorFeatureError } from "./rollout";

const value = { version: 1, instance: "odim", allowedOperatorIds: [534], effectiveAt: "2026-11-16T12:00:00.123Z", features: { operator: true, telephony: true, crm: true, whatsapp: true } };
test("strict shared profile binds raw-byte revision and an exact UTC cutoff", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-feature-")), file = path.join(dir, "policy.json");
	try {
		const raw = JSON.stringify(value); fs.writeFileSync(file, raw, { mode: 0o600 });
		const policy = readOperatorFeaturePolicy(file);
		assert.equal(policy.revision, createHash("sha256").update(raw).digest("hex"));
		assert.equal(policy.effectiveAt, value.effectiveAt);
		for (const change of [{ effectiveAt: undefined }, { effectiveAt: "2026-11-16T12:00:00Z" }, { effectiveAt: "2026-11-31T12:00:00.123Z" }, { allowedOperatorIds: [534, 1] }, { instance: "ODIM" }, { features: { operator: true, telephony: true, crm: true } }, { extra: true }]) {
			fs.writeFileSync(file, JSON.stringify({ ...value, ...change }));
			assert.throws(() => readOperatorFeaturePolicy(file), e => e instanceof OperatorFeatureError && e.status === 503);
		}
		fs.unlinkSync(file); assert.throws(() => readOperatorFeaturePolicy(file), e => e instanceof OperatorFeatureError && e.status === 503);
	} finally { fs.rmSync(dir, { recursive: true }); }
});
test("only ODIM534 is eligible, with canonical aliases and no role bypass", () => {
	const read = () => ({ ...value, revision: "a".repeat(64) });
	for (const instance of ["odim", " ODIM ", "ódim", "ｏｄｉｍ", "od\u200dim"]) {
		assert.equal(operatorFeatures({ instance, userId: 534 }, read).features.whatsapp, true);
		for (const userId of [1, 6, 533, 535]) for (const feature of ["operator", "telephony", "crm", "whatsapp"] as const) {
			assert.throws(() => assertOperatorFeature({ instance, userId }, feature, read), e => e instanceof OperatorFeatureError && e.status === 403);
		}
		assert.deepEqual(whatsappEligibleIds(instance, [1, 6, 534, 535], read), [534]);
		assert.deepEqual(whatsappEligibleIds(instance, [1, 6, 535], read), [], "never inject the pilot into an ineligible sector/wallet candidate list");
	}
	assert.equal(operatorFeatures({ instance: "suprimaxxi", userId: 1 }, () => { throw Error("must not read ODIM policy"); }).managed, false);
});
test("read/history requests stay available and accepted message receipts reach their lookup", () => {
	for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal(requiredWhatsAppFeature(method, "/api/whatsapp/chats"), null);
	assert.equal(requiredWhatsAppFeature("POST", "/api/whatsapp/monitor/search"), null);
	assert.equal(requiredWhatsAppFeature("POST", "/api/whatsapp/:clientId/messages"), null);
	for (const route of ["/api/whatsapp/1/messages/forward", "/api/whatsapp/1/templates/send", "/api/whatsapp/chats", "/api/whatsapp/chats/1/transfer", "/api/whatsapp/messages/mark-as-read", "/api/message-flows/1", "/api/whatsapp/schedules"]) {
		assert.equal(requiredWhatsAppFeature("POST", route), "whatsapp");
	}
});
