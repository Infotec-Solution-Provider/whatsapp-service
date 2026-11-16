import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import express from "express";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { operatorFeatureProfilePath, OperatorFeatureError } from "./rollout";
import { lockRuntimeAdmission, type RuntimeTx } from "../operator-runtime/core";
import { executeCentralRuntime } from "../operator-runtime/engine";
import { createOperatorRuntimeRouter } from "../operator-runtime/router";
import { CentralOperatorAdmission, pauseAdmissionFailure } from "../services/central-operator-admission";

const policy = { version: 1, instance: "odim", allowedOperatorIds: [534], effectiveAt: "2026-11-16T12:00:00.123Z", features: { operator: true, telephony: true, crm: true, whatsapp: true } };
test("pilot runtime/admission: nonpilot is ignored by pause but cannot create/send; OFF has no SIP fallback", async () => {
	assert.equal(fs.existsSync(operatorFeatureProfilePath), false, "fixture must never overwrite a profile");
	fs.writeFileSync(operatorFeatureProfilePath, JSON.stringify(policy), { flag: "wx", mode: 0o600 });
	let enabled = 1; const writes: unknown[][] = [], queried: string[] = [];
	const tx: RuntimeTx = {
		$queryRawUnsafe: async <T>(sql: string, ...params: unknown[]) => {
			queried.push(sql);
			if (sql.includes("information_schema")) return [{ TABLE_NAME: "operator_runtime_policy" }] as T;
			if (sql.includes("FROM operator_runtime_policy")) return [{ enabled, schema_version: 1, revision: 4, review_sha256: "a".repeat(64) }] as T;
			if (sql.includes("FROM operator_runtime_state")) return [{ operator_id: params[1], state: "available", version: 0 }] as T;
			return [] as T;
		},
		$executeRawUnsafe: async (...input) => { writes.push(input); return 1; }
	};
	try {
		const locked = await lockRuntimeAdmission(tx, "ODIM", [535, 534]);
		assert.equal(locked.states.get(535)?.ignored, true); assert.equal(locked.states.get(535)?.state, "available");
		assert.equal(locked.states.get(534)?.ignored, undefined);
		assert.equal(writes.length, 1); assert.deepEqual(writes[0]?.slice(1), ["odim", 534]);
		const gate = new CentralOperatorAdmission(lockRuntimeAdmission);
		enabled = 0;
		await assert.rejects(gate.assertSend(tx, { instance: "ODIM", actorId: 535 }), e => e instanceof OperatorFeatureError && e.status === 403);
		await assert.rejects(gate.assert(tx, { instance: "odim", initiatorId: 535, recipientId: -1 }), e => e instanceof OperatorFeatureError && e.status === 403);
		await assert.rejects(gate.assert(tx, { instance: "odim", humanActorId: 534, recipientId: 535 }), e => e instanceof OperatorFeatureError && e.status === 403);
		await assert.rejects(gate.assert(tx, { instance: "odim", recipientId: 535 }), e => pauseAdmissionFailure(e)?.status === 503);
		await gate.assert(tx, { instance: "odim", initiatorId: 534, recipientId: -1 });
		assert.deepEqual([...await gate.eligible(tx, "odim", [535, 534, 1])], [534]);
		for (const action of ["status", "prepare", "metrics", "session", "pause"] as const) {
			await assert.rejects(executeCentralRuntime(tx, "odim", { operation: "operator.runtime", action, actorId: 535, input: {} }), e => e instanceof OperatorFeatureError && e.status === 403);
			await assert.rejects(executeCentralRuntime(tx, "odim", { operation: "operator.runtime", action, actorId: 534, input: {} }), e => e instanceof OperatorFeatureError && e.code === "OPERATOR_FEATURE_PILOT_PENDING" && e.status === 503);
		}
		assert.deepEqual(await executeCentralRuntime(tx, "odim", { operation: "operator.runtime", action: "policy", actorId: 1, input: {} }), { authority: "central-v1", enabled: false });
		const legacy = await executeCentralRuntime(tx, "suprimaxxi", { operation: "operator.runtime", action: "status", actorId: 1, input: {} }) as { enabled: boolean };
		assert.equal(legacy.enabled, false); assert.ok(queried.length > 0);
		const app = express(), key = randomBytes(32);
		app.use(createOperatorRuntimeRouter({ $transaction: run => run(tx) }, () => ({ authority: "central-v1", instances: ["odim"], signingKeyFile: "/unused-fixture" }), () => key));
		const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
		const address = server.address(); assert.ok(address && typeof address !== "string");
		try {
			for (const [actorId, action, expectedStatus, expectedCode] of [[535, "status", 403, "OPERATOR_FEATURE_PILOT_REQUIRED"], [534, "status", 503, "OPERATOR_FEATURE_PILOT_PENDING"], [534, "prepare", 503, "OPERATOR_FEATURE_PILOT_PENDING"]] as const) {
				const path = "/api/internal/operator-runtime/odim/commands", body = JSON.stringify({ operation: "operator.runtime", actorId, action, input: {} }), timestamp = String(Date.now()), nonce = randomUUID();
				const signature = createHmac("sha256", key).update(`${timestamp}\n${nonce}\n${path}\n${body}`).digest("hex");
				const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-operator-timestamp": timestamp, "x-operator-nonce": nonce, "x-operator-signature": signature }, body });
				assert.equal(response.status, expectedStatus); assert.deepEqual(await response.json(), { code: expectedCode, outcome: "NOT_COMMITTED" });
			}
		} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
	} finally { fs.unlinkSync(operatorFeatureProfilePath); }
});
