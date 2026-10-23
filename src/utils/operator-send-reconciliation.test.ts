import assert from "node:assert/strict";
import type { WppMessage } from "@prisma/client";
import type { RemoteMessageJobResponse } from "../types/remote-client.types";
import { reconcileOperatorMessage, OperatorReconciliationClient, OperatorReconciliationInput } from "./operator-send-reconciliation";

async function run(): Promise<void> {
	const item: OperatorReconciliationInput = {
		id: "local-job", instance: "tenant", clientId: 11, deliveryMode: "REMOTE", remoteJobId: "known-job",
		message: { instance: "tenant", clientId: 11, wwebjsId: null, wwebjsIdStanza: null },
	};
	const base: RemoteMessageJobResponse = {
		contractVersion: 1, jobId: "known-job", idempotencyKey: "operator-outbound:v1:local-job",
		status: "SENT", result: { wwebjsIdStanza: "stanza", status: "RECEIVED" } as RemoteMessageJobResponse["result"],
		error: null, attempts: 1, createdAt: "2026-10-23T12:00:00Z", updatedAt: "2026-10-23T12:05:00Z",
	};
	let answer = base;
	let lookups = 0;
	let sends = 0;
	const client: OperatorReconciliationClient & { sendMessage(): never; submitMessageJob(): never } = {
		id: 11, instance: "tenant",
		getMessageJob: async (id) => { lookups++; assert.equal(id, "known-job"); return answer; },
		sendMessage: () => { sends++; throw new Error("must never dispatch"); },
		submitMessageJob: () => { sends++; throw new Error("must never submit"); },
	};
	assert.deepEqual(await reconcileOperatorMessage(item, client), {
		status: "SENT", remoteJobId: "known-job", result: { wwebjsIdStanza: "stanza" },
	}, "receipt-driven minimal contract v1 result can converge");
	for (const patch of [{ instance: "other" }, { clientId: 12 }, { instance: null }, { clientId: "11" }]) {
		answer = { ...base, result: { ...base.result, ...patch } as RemoteMessageJobResponse["result"] };
		assert.equal((await reconcileOperatorMessage(item, client)).status, "UNKNOWN");
	}
	for (const patch of [{ jobId: "another" }, { idempotencyKey: "operator-outbound:v1:another" }, { contractVersion: 2 }]) {
		answer = { ...base, ...patch } as RemoteMessageJobResponse;
		assert.equal((await reconcileOperatorMessage(item, client)).status, "UNKNOWN");
	}
	answer = base;
	const before = lookups;
	for (const input of [{ ...item, deliveryMode: "DIRECT" as const }, { ...item, remoteJobId: null },
		{ ...item, clientId: 12 }, { ...item, instance: "other" },
		{ ...item, message: { ...item.message, instance: "other" } }]) {
		assert.equal((await reconcileOperatorMessage(input, client)).status, "UNKNOWN");
	}
	assert.equal(lookups, before, "invalid local tenant/channel/job never reaches remote service");
	assert.equal((await reconcileOperatorMessage(item, undefined)).status, "UNKNOWN");
	assert.equal((await reconcileOperatorMessage(item, { id: 11, instance: "tenant" })).status, "UNKNOWN");
	assert.equal((await reconcileOperatorMessage({ ...item, message: { ...item.message, wwebjsIdStanza: "conflicting" } }, client)).status, "UNKNOWN");
	for (const status of ["PENDING", "PROCESSING", "UNKNOWN"] as const) {
		answer = { ...base, status };
		assert.equal((await reconcileOperatorMessage(item, client)).status, "UNKNOWN");
	}
	for (const result of [null, {}, { body: "untrusted" }]) {
		answer = { ...base, result: result as RemoteMessageJobResponse["result"] };
		assert.equal((await reconcileOperatorMessage(item, client)).status, "UNKNOWN");
	}
	answer = { ...base, result: { ...base.result, instance: "tenant", clientId: 11, body: "untrusted", userId: 999 } as RemoteMessageJobResponse["result"] };
	const safe = await reconcileOperatorMessage(item, client);
	assert.deepEqual(safe.result, { wwebjsIdStanza: "stanza" } as Partial<WppMessage>);
	answer = { ...base, status: "FAILED", result: null, error: "Connection Closed; private provider detail" };
	assert.deepEqual(await reconcileOperatorMessage(item, client), {
		status: "FAILED", remoteJobId: "known-job", error: "O provedor confirmou falha no envio.", failureCategory: "CHANNEL",
	});
	for (const failure of [{ response: { status: 404 } }, { response: { status: 503 } }, new Error("secret credential")]) {
		const unavailable = { ...client, getMessageJob: async () => { throw failure; } };
		assert.deepEqual(await reconcileOperatorMessage(item, unavailable), { status: "UNKNOWN" });
	}
	assert.equal(sends, 0);
	console.log("Operator reconciliation: minimal receipts, scope/identity, uncertainty, unavailable and zero dispatch passed");
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });
