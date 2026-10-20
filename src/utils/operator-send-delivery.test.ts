import assert from "node:assert/strict";
import type CreateMessageDto from "../dtos/create-message.dto";
import type { RemoteMessageJobResponse } from "../types/remote-client.types";
import { deliverOperatorMessage, OperatorDeliveryClient, OperatorDeliveryInput } from "./operator-send-delivery";
import { classifyWabaSendError, wabaPreparationError } from "./waba-send";
import { shouldApplyRemoteStatus } from "./remote-message-status";

async function testReceiptConfirmationWindow(): Promise<void> {
	const originalNow = Date.now;
	const startedAt = Date.parse("2026-10-20T15:00:00.000Z");
	let now = startedAt;
	Date.now = () => now;
	try {
		const providerMessageId = "A123456789ABCDEF0123456789ABCDEF";
		const item: OperatorDeliveryInput = { id: "receipt-window", instance: "tenant", deliveryMode: "REMOTE", remoteJobId: null };
		const options = { to: "5511999999999", text: "Documento de teste" };
		const base: RemoteMessageJobResponse = {
			contractVersion: 1, jobId: "receipt-job", idempotencyKey: "operator-outbound:v1:receipt-window",
			status: "UNKNOWN", result: null, error: "uncertain send", attempts: 1,
			createdAt: new Date(startedAt).toISOString(), updatedAt: new Date(startedAt).toISOString(),
			confirmationStatus: "VERIFYING", confirmationDeadlineAt: new Date(startedAt + 120_000).toISOString(),
			providerMessageId,
		};
		let remote = { ...base };
		let submissions = 0;
		let lookups = 0;
		const client: OperatorDeliveryClient = {
			instance: "tenant",
			sendMessage: async () => { throw new Error("A receipt lookup must never dispatch synchronously"); },
			submitMessageJob: async (_options, _isGroup, key) => {
				submissions++;
				assert.equal(key, base.idempotencyKey);
				return remote;
			},
			getMessageJob: async (jobId) => { lookups++; assert.equal(jobId, base.jobId); return remote; },
		};
		assert.deepEqual(await deliverOperatorMessage(item, options, client), {
			status: "PENDING", remoteJobId: base.jobId, error: "Verificando envio. Não reenviar automaticamente.",
		}, "an uncertain submission remains pending only for its bounded receipt window");
		const linked = { ...item, remoteJobId: base.jobId };
		now += 11_000;
		assert.equal((await deliverOperatorMessage(linked, options, client)).status, "PENDING");
		now += 30_000;
		remote = { ...base, status: "SENT", result: { wwebjsIdStanza: providerMessageId, status: "RECEIVED" } as NonNullable<RemoteMessageJobResponse["result"]> };
		const confirmed = await deliverOperatorMessage(linked, options, client);
		assert.deepEqual(confirmed, { status: "SENT", remoteJobId: base.jobId, result: { wwebjsIdStanza: providerMessageId } });
		assert.equal(shouldApplyRemoteStatus("SENT", "RECEIVED"), true, "the linked receipt may advance the message after polling succeeds");
		assert.equal(submissions, 1, "confirmation never resubmits a known remote job");
		assert.equal(lookups, 2);

		remote = { ...base };
		assert.equal((await deliverOperatorMessage(linked, options, client)).status, "PENDING");
		now = startedAt + 120_000;
		remote = { ...base, confirmationStatus: "TIMED_OUT" };
		const timedOut = await deliverOperatorMessage(linked, options, client);
		assert.equal(timedOut.status, "UNKNOWN", "timeout cannot imply failure or safe resend");
		assert.deepEqual(timedOut.result, { wwebjsIdStanza: providerMessageId }, "the reserved identity survives terminal uncertainty for later receipt correlation");
		assert.equal(shouldApplyRemoteStatus("UNKNOWN", "RECEIVED"), true);
		assert.equal(shouldApplyRemoteStatus("UNKNOWN", "READ"), true);

		for (const deadline of [undefined, null, "", "invalid", new Date(now - 1).toISOString(), new Date(now).toISOString(), new Date(now + 120_001).toISOString()]) {
			remote = { ...base };
			delete remote.confirmationDeadlineAt;
			if (deadline !== undefined) remote.confirmationDeadlineAt = deadline;
			assert.equal((await deliverOperatorMessage(linked, options, client)).status, "UNKNOWN", `invalid or unbounded receipt window must close: ${deadline}`);
		}
		for (const invalidId of [undefined, null, "", "not-an-id", "A".repeat(31), "A".repeat(33), "G".repeat(32), ` ${providerMessageId}`, `${providerMessageId}\n`]) {
			remote = { ...base, confirmationStatus: "TIMED_OUT" };
			delete remote.providerMessageId;
			if (invalidId !== undefined) remote.providerMessageId = invalidId;
			const outcome = await deliverOperatorMessage(linked, options, client);
			assert.equal(outcome.status, "UNKNOWN");
			assert.equal(outcome.result, undefined, "an invalid reserved identity must never be persisted");
		}
		assert.equal(submissions, 1, "expired/invalid windows and late receipts never create a new attempt");
	} finally {
		Date.now = originalNow;
	}
}

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
	client.getMessageJob = async () => ({ ...response("FAILED"), error: "Connection Closed; private provider detail" });
	const technicalFailure = await deliverOperatorMessage({ ...item, remoteJobId: "remote-job" }, options, client);
	assert.equal(technicalFailure.failureCategory, "CHANNEL");
	assert.equal(technicalFailure.error, "O provedor confirmou falha no envio.", "health category does not expose raw provider errors");
	client.getMessageJob = async () => ({ ...response("FAILED"), error: "Invalid recipient" });
	assert.equal((await deliverOperatorMessage({ ...item, remoteJobId: "remote-job" }, options, client)).failureCategory, "MESSAGE");
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
	const secret = "https://user:password@provider.example/send?token=private-message";
	for (const remoteJobId of [null, "remote-job"]) {
		let submissions = 0;
		let lookups = 0;
		let remoteResponse: unknown = response("SENT");
		let requestFailure: unknown;
		const guardedClient: OperatorDeliveryClient = {
			...client,
			submitMessageJob: async () => {
				submissions++;
				if (requestFailure) throw requestFailure;
				return remoteResponse as RemoteMessageJobResponse;
			},
			getMessageJob: async () => {
				lookups++;
				if (requestFailure) throw requestFailure;
				return remoteResponse as RemoteMessageJobResponse;
			},
		};
		for (let status = 400; status < 500; status++) {
			requestFailure = { code: "ERR_BAD_REQUEST", message: secret, response: { status, data: { error: secret } } };
			const failure = await deliverOperatorMessage({ ...item, remoteJobId }, options, guardedClient);
			assert.equal(failure.status, [408, 425, 429].includes(status) ? "PENDING" : "UNKNOWN", `HTTP ${status} on ${remoteJobId ? "lookup" : "submission"}`);
			assert.ok(failure.error?.includes(`HTTP ${status}; ERR_BAD_REQUEST`));
			assert.ok(!failure.error?.includes(secret), "request diagnostics never include provider messages or bodies");
		}
		for (const status of [500, 502, 503, 504]) {
			requestFailure = { response: { status }, code: "ERR_BAD_RESPONSE" };
			const failure = await deliverOperatorMessage({ ...item, remoteJobId }, options, guardedClient);
			assert.equal(failure.status, "PENDING");
			assert.ok(failure.error?.includes(`HTTP ${status}; ERR_BAD_RESPONSE`));
		}
		requestFailure = { code: "ETIMEDOUT", message: secret };
		assert.deepEqual(await deliverOperatorMessage({ ...item, remoteJobId }, options, guardedClient), {
			status: "PENDING", error: "Aguardando confirmação do serviço de mensagens (ETIMEDOUT).",
		});
		requestFailure = { code: secret, message: secret, response: { status: 700, data: secret } };
		assert.deepEqual(await deliverOperatorMessage({ ...item, remoteJobId }, options, guardedClient), {
			status: "PENDING", error: "Aguardando confirmação do serviço de mensagens.",
		}, "unrecognized error codes and invalid HTTP statuses are omitted");
		requestFailure = undefined;
		for (const malformed of [null, undefined, "", "accepted", 1, false, [], {}]) {
			remoteResponse = malformed;
			assert.deepEqual(await deliverOperatorMessage({ ...item, remoteJobId }, options, guardedClient), {
				status: "UNKNOWN", error: "Resposta de reconciliação inválida.",
			}, "malformed successful responses must not keep resubmitting");
		}
		assert.equal(remoteJobId ? submissions : lookups, 0, "known jobs only use lookup; unknown job IDs only reuse submission");
	}
	assert.equal(directCalls, 0, "request failures and malformed remote responses never fall back to synchronous sending");
	client.sendMessage = async (sendOptions) => {
		directCalls++;
		assert.equal(sendOptions.preventAutomaticRetry, true);
		throw new Error("provider accepted then connection interrupted");
	};
	assert.equal((await deliverOperatorMessage({ ...item, deliveryMode: "DIRECT" }, options, client)).status, "UNKNOWN");
	assert.equal(directCalls, 1);
	assert.equal((await deliverOperatorMessage(item, options, { ...client, instance: "other" })).status, "PENDING");
	assert.equal(directCalls, 1, "tenant mismatch must never reach provider");
	const rejection = classifyWabaSendError({ response: { status: 400, data: { error: {
		code: 100, message: "Invalid media attachment ID", fbtrace_id: "trace-rejection",
	} } } });
	client.sendMessage = async () => { throw rejection; };
	assert.deepEqual(await deliverOperatorMessage({ ...item, deliveryMode: "DIRECT" }, options, client), {
		status: "FAILED", error: rejection.message, failureCategory: "MESSAGE",
	}, "official rejection retains the original safe cause and is a confirmed failure");
	client.sendMessage = async () => { throw wabaPreparationError(new Error("upload unavailable")); };
	assert.equal((await deliverOperatorMessage({ ...item, deliveryMode: "DIRECT" }, options, client)).status, "FAILED");
	client.sendMessage = async () => { throw classifyWabaSendError({ code: "ETIMEDOUT" }); };
	assert.equal((await deliverOperatorMessage({ ...item, deliveryMode: "DIRECT" }, options, client)).status, "UNKNOWN");
	client.sendMessage = async () => { throw { deliveryStatus: "FAILED", message: "untrusted provider error" }; };
	assert.equal((await deliverOperatorMessage({ ...item, deliveryMode: "DIRECT" }, options, client)).status, "UNKNOWN",
		"untyped errors from other clients cannot opt into safe failure");
	await testReceiptConfirmationWindow();
	console.log("operator-send-delivery: response loss, same intent, scoped results, UNKNOWN and no fallback passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
