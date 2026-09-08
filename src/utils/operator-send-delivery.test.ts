import assert from "node:assert/strict";
import type CreateMessageDto from "../dtos/create-message.dto";
import type { RemoteMessageJobResponse } from "../types/remote-client.types";
import { deliverOperatorMessage, OperatorDeliveryClient, OperatorDeliveryInput } from "./operator-send-delivery";

async function main() {
	const item: OperatorDeliveryInput = { id: "attempt-one", instance: "tenant", deliveryMode: "REMOTE", remoteJobId: null };
	const key = "operator-outbound:v1:attempt-one";
	const options = { to: "5511999999999", text: "Olá" };
	const result = { wwebjsId: "provider-id", wwebjsIdStanza: "stanza", status: "PENDING", body: "untrusted", userId: 999, instance: "different" } as CreateMessageDto;
	const response = (status: RemoteMessageJobResponse["status"]): RemoteMessageJobResponse => ({
		contractVersion: 1, jobId: "remote-job", idempotencyKey: key, status,
		result: result as RemoteMessageJobResponse["result"], error: null, attempts: 1,
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	});
	let directCalls = 0;
	let submitCalls = 0;
	let delivered = 0;
	const remoteKeys = new Set<string>();
	const client: OperatorDeliveryClient = {
		instance: "tenant",
		sendMessage: async () => { directCalls++; return result; },
		submitMessageJob: async (_options, _group, attemptKey) => {
			submitCalls++;
			if (!remoteKeys.has(attemptKey)) { remoteKeys.add(attemptKey); delivered++; }
			if (submitCalls === 1) throw new Error("response lost after persistence");
			return response("SENT");
		},
		getMessageJob: async () => response("SENT"),
	};
	assert.equal((await deliverOperatorMessage(item, options, client)).status, "PENDING");
	const replay = await deliverOperatorMessage(item, options, client);
	assert.equal(replay.status, "SENT");
	assert.deepEqual(replay.result, { wwebjsId: "provider-id", wwebjsIdStanza: "stanza" }, "provider cannot overwrite tenant, author, body or public ID");
	assert.equal(delivered, 1, "retry after lost response uses same remote intent");
	assert.equal(directCalls, 0, "durable requests never fall back to synchronous sends");
	client.getMessageJob = async () => { throw { response: { status: 404 } }; };
	assert.equal((await deliverOperatorMessage({ ...item, remoteJobId: "remote-job" }, options, client)).status, "UNKNOWN");
	assert.equal(submitCalls, 2, "missing known job does not submit a new message");
	client.getMessageJob = async () => ({ ...response("SENT"), result: {} as NonNullable<RemoteMessageJobResponse["result"]> });
	const missingId = await deliverOperatorMessage({ ...item, remoteJobId: "remote-job" }, options, client);
	assert.equal(missingId.status, "UNKNOWN");
	assert.equal(missingId.remoteJobId, "remote-job");
	client.getMessageJob = async () => ({ ...response("SENT"), idempotencyKey: "another-intent" });
	assert.equal((await deliverOperatorMessage({ ...item, remoteJobId: "remote-job" }, options, client)).status, "UNKNOWN");
	for (const status of ["PENDING", "PROCESSING", "FAILED", "UNKNOWN"] as const) {
		client.getMessageJob = async () => response(status);
		assert.equal((await deliverOperatorMessage({ ...item, remoteJobId: "remote-job" }, options, client)).status, status === "PROCESSING" ? "PENDING" : status);
	}
	client.sendMessage = async (sendOptions) => {
		directCalls++;
		assert.equal(sendOptions.preventAutomaticRetry, true);
		throw new Error("provider accepted then connection interrupted");
	};
	assert.equal((await deliverOperatorMessage({ ...item, deliveryMode: "DIRECT" }, options, client)).status, "UNKNOWN");
	assert.equal(directCalls, 1);
	assert.equal((await deliverOperatorMessage(item, options, { ...client, instance: "other" })).status, "PENDING");
	assert.equal(directCalls, 1, "tenant mismatch must never reach provider");
	console.log("operator-send-delivery: response loss, same intent, scoped results, UNKNOWN and no fallback passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
