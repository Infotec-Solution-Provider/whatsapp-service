import assert from "node:assert/strict";
import { test } from "node:test";
import { homologTriageEnabled, resolveTriageFlag } from "./triage-feature";

test("override da homologação requer identidade do ambiente e do processo", () => {
	const homolog = { INPULSE_ENVIRONMENT: "homolog", TRIAGE_HOMOLOG_ENABLED: "true", name: "homolog-whatsapp" };
	assert.equal(resolveTriageFlag("false", homolog), true);
	assert.equal(resolveTriageFlag(undefined, homolog), true);
	assert.equal(homologTriageEnabled({ ...homolog, name: "whatsapp" }), false);
	assert.equal(homologTriageEnabled({ ...homolog, INPULSE_ENVIRONMENT: "production" }), false);
	assert.equal(homologTriageEnabled({ ...homolog, TRIAGE_HOMOLOG_ENABLED: "false" }), false);
	assert.equal(resolveTriageFlag(undefined, {}), false);
	assert.equal(resolveTriageFlag("true", {}), true);
});
