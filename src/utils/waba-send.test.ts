import assert from "node:assert/strict";
import { classifyWabaSendError, sendWabaRequest, WabaDeliveryError, wabaPreparationError } from "./waba-send";

const invalidMedia = (type = "image", status = 400) => ({
	response: { status, data: { error: {
		code: 100, type: "OAuthException", fbtrace_id: "trace-123",
		message: `Param ${type}.id is not a valid whatsapp business account media attachment ID`,
	} } },
	config: { headers: { Authorization: "Bearer secret-token" } },
	request: { private: "must-not-leak" },
});

async function main() {
	for (const type of ["image", "document", "video", "audio", "sticker"]) {
		let sends = 0;
		let renews = 0;
		let id = "old";
		const result = await sendWabaRequest(async () => {
			sends++;
			if (id === "old") throw invalidMedia(type);
			return { messages: [{ id: "wamid.new" }] };
		}, { type, renew: async () => { renews++; id = "fresh"; } });
		assert.equal(result.id, "wamid.new");
		assert.equal(sends, 2);
		assert.equal(renews, 1);
	}
	let sends = 0;
	let renews = 0;
	await assert.rejects(() => sendWabaRequest(async () => { sends++; throw invalidMedia(); }, {
		type: "image", renew: async () => { renews++; },
	}), (e: unknown) => e instanceof WabaDeliveryError && e.deliveryStatus === "FAILED" && e.message.includes("Meta 100") && e.message.includes("trace-123"));
	assert.equal(sends, 2, "persistent rejection must not loop");
	assert.equal(renews, 1);

	const scenarios: Array<{ error: unknown; status: "FAILED" | "UNKNOWN" }> = [
		{ error: { code: "ETIMEDOUT", message: "response may have been lost" }, status: "UNKNOWN" },
		{ error: { code: "ECONNRESET" }, status: "UNKNOWN" },
		{ error: new Error("provider accepted before local failure"), status: "UNKNOWN" },
		{ error: invalidMedia("image", 500), status: "UNKNOWN" },
		{ error: invalidMedia("image", 408), status: "UNKNOWN" },
		{ error: { response: { status: 400, data: { error: { code: 131000, message: "Something went wrong" } } } }, status: "UNKNOWN" },
		{ error: { response: { status: 400, data: { error: { code: 100, message: "Invalid parameter", is_transient: true } } } }, status: "UNKNOWN" },
		{ error: { response: { status: 400, data: "gateway response" } }, status: "UNKNOWN" },
		{ error: { response: { status: 400, data: { error: { code: 100, message: "Invalid to" } } } }, status: "FAILED" },
		{ error: { response: { status: 401, data: { error: { code: 190, message: "Invalid access token" } } } }, status: "FAILED" },
		{ error: { response: { status: 429, data: { error: { code: 131056, message: "Rate limit" } } } }, status: "FAILED" },
		{ error: invalidMedia("document"), status: "FAILED" },
		{ error: { response: { status: 400, data: { ...invalidMedia().response.data, messages: [{ id: "accepted" }] } } }, status: "UNKNOWN" },
	];
	for (const { error, status } of scenarios) {
		let calls = 0;
		await assert.rejects(() => sendWabaRequest(async () => { calls++; throw error; }, {
			type: "image", renew: async () => { assert.fail("must not refresh media for unrelated/ambiguous errors"); },
		}), (e: unknown) => e instanceof WabaDeliveryError && e.deliveryStatus === status);
		assert.equal(calls, 1);
	}
	for (const response of [{}, { messages: [] }, { messages: [{}] }, { messages: [{ id: "" }] }]) {
		let calls = 0;
		await assert.rejects(() => sendWabaRequest(async () => { calls++; return response; }),
			(e: unknown) => e instanceof WabaDeliveryError && e.deliveryStatus === "UNKNOWN");
		assert.equal(calls, 1, "a success response without ID cannot be resent");
	}
	let calls = 0;
	await assert.rejects(() => sendWabaRequest(async () => { calls++; throw invalidMedia(); }, {
		type: "image", renew: async () => { throw { code: "ETIMEDOUT" }; },
	}), (e: unknown) => e instanceof WabaDeliveryError && e.deliveryStatus === "FAILED");
	assert.equal(calls, 1, "refresh/upload timeout after rejection did not send another message");

	calls = 0;
	await assert.rejects(() => sendWabaRequest(async () => {
		calls++;
		if (calls === 1) throw invalidMedia();
		throw { code: "ECONNRESET" };
	}, { type: "image", renew: async () => {} }),
	(e: unknown) => e instanceof WabaDeliveryError && e.deliveryStatus === "UNKNOWN");
	assert.equal(calls, 2, "ambiguous second send must stay UNKNOWN with no third send");

	const safe = classifyWabaSendError(invalidMedia());
	assert.equal(safe.deliveryStatus, "FAILED");
	assert.equal(safe.details.code, 100);
	assert.equal(safe.details.traceId, "trace-123");
	assert.doesNotMatch(JSON.stringify(safe), /secret-token|must-not-leak|Authorization|config|request/);
	for (const message of [
		'Invalid input {"access_token":"SYNTHETIC_SECRET", "password":"SYNTHETIC_PASSWORD"}',
		"Invalid input {'authorization': 'Bearer SYNTHETIC_SECRET', 'password':'SYNTHETIC_PASSWORD'}",
		"Invalid token access_token=SYNTHETIC_SECRET&password=SYNTHETIC_PASSWORD",
	]) {
		const redacted = classifyWabaSendError({ response: { status: 400, data: { error: { code: 100, message } } } });
		assert.doesNotMatch(JSON.stringify(redacted), /SYNTHETIC_SECRET|SYNTHETIC_PASSWORD/);
		assert.doesNotMatch(redacted.message, /SYNTHETIC_SECRET|SYNTHETIC_PASSWORD/);
	}
	assert.equal(wabaPreparationError(new Error("secret upload response")).deliveryStatus, "FAILED");
	assert.doesNotMatch(wabaPreparationError(new Error("secret upload response")).message, /secret upload response/);
	console.log("waba-send: invalid-media renewal, definitive rejection, ambiguous results, bounded retry and safe diagnostics passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
