import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { MetaGraphError, MetaManagementGraph } from "./meta-management.graph";

const accountId = "101010";
const phoneId = "202020";
const token = "test-fixture-token-never-log";
const baseUrl = "https://graph.facebook.com";
const versionPath = "/v26.0";
const template = {
	name: "lembrete_agendamento",
	language: "pt_BR",
	category: "UTILITY" as const,
	body: "Olá, {{1}}. Seu atendimento está marcado para {{2}}.",
	examples: ["Maria", "segunda-feira"],
};

type GraphCall = { url: URL; init: RequestInit };
type Reply = (call: GraphCall) => Response | Promise<Response>;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function graphWithReplies(...replies: Reply[]) {
	const calls: GraphCall[] = [];
	const transport: typeof fetch = async (input, init = {}) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const call = { url, init };
		calls.push(call);
		assert.equal(url.origin, baseUrl);
		assert.equal(url.searchParams.has("access_token"), false);
		const reply = replies.shift();
		assert.ok(reply, `Unexpected Graph call to ${url}`);
		return reply(call);
	};
	return { graph: new MetaManagementGraph(token, transport), calls };
}

test("keeps the channel token private if the client is inspected or serialized", () => {
	const { graph } = graphWithReplies();
	assert.ok(!inspect(graph, { depth: 6 }).includes(token));
	assert.ok(!JSON.stringify(graph).includes(token));
});

test("loads templates with filters and cursors on the authorized account's pinned Graph endpoint", async () => {
	const { graph, calls } = graphWithReplies(() => json({
		data: [{ id: "7991", name: template.name, language: template.language, category: template.category, status: "PENDING" }],
		paging: { cursors: { after: "page-by-cursor" }, next: "https://wrong.example/relay?access_token=do-not-use" },
	}));
	const result = await graph.listTemplates(accountId, { after: "previous+cursor", language: "pt_BR", status: "PENDING" });
	assert.equal(calls.length, 1);
	const [request] = calls;
	assert.ok(request);
	assert.equal(request.url.pathname, `${versionPath}/${accountId}/message_templates`);
	assert.equal(request.url.searchParams.get("language"), "pt_BR");
	assert.equal(request.url.searchParams.get("status"), "PENDING");
	assert.equal(request.url.searchParams.get("after"), "previous+cursor");
	assert.equal(new Headers(request.init.headers).get("authorization"), `Bearer ${token}`);
	assert.equal(result.nextCursor, "page-by-cursor");
	assert.doesNotMatch(JSON.stringify(result), /wrong\.example|do-not-use/);
});

test("keeps paginated status and quality data on the authorized numbers endpoint", async () => {
	const { graph, calls } = graphWithReplies(() => json({
		data: [{ id: phoneId, display_phone_number: "+55 11 0000-0000", status: "CONNECTED", quality_rating: "GREEN" }],
		paging: { cursors: { after: "another-page" }, next: "https://wrong.example/" },
	}), () => json({ data: [{ id: "404040", verified_name: "Conta piloto", status: "PENDING" }] }));
	const numbers = await graph.listNumbers(accountId);
	assert.deepEqual(numbers, [
		{ id: phoneId, phone: "+55 11 0000-0000", verifiedName: null, status: "CONNECTED", qualityRating: "GREEN" },
		{ id: "404040", phone: null, verifiedName: "Conta piloto", status: "PENDING", qualityRating: null },
	]);
	assert.deepEqual(calls.map((call) => call.url.pathname), Array(2).fill(`${versionPath}/${accountId}/phone_numbers`));
	assert.equal(calls[1]?.url.searchParams.get("after"), "another-page");
});

const pricingFrom = new Date("2026-11-01T03:00:00Z");
const pricingTo = new Date("2026-12-01T03:00:00Z");
const pricingPhone = "551100000000";
const marketingPoint = {
	phone_number: pricingPhone, pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 2, cost: 0.1
};

test("queries costs and billing currency for the selected number and aggregates all safe pages", async () => {
	const { graph, calls } = graphWithReplies(() => json({ currency: "BRL" }), () => json({
		data: [{ data_points: [marketingPoint] }],
		paging: { cursors: { after: "next-pricing-page" }, next: "https://wrong.example/?access_token=ignore" }
	}), () => json({
		data: [{ data_points: [
			{ ...marketingPoint, cost: 0.2 },
			{ ...marketingPoint, pricing_category: "SERVICE", pricing_type: "FREE_CUSTOMER_SERVICE", volume: 3, cost: 0 }
		] }]
	}));
	const result = await graph.getPricingAnalytics(accountId, "+55 (11) 0000-0000", pricingFrom, pricingTo);
	assert.deepEqual(result, {
		currency: "BRL", totalCost: 0.3, totalVolume: 7,
		buckets: [
			{ category: "MARKETING", pricingType: "REGULAR", volume: 4, cost: 0.3 },
			{ category: "SERVICE", pricingType: "FREE_CUSTOMER_SERVICE", volume: 3, cost: 0 },
		]
	});
	assert.deepEqual(calls.map(({ url }) => url.pathname), [
		`${versionPath}/${accountId}`, `${versionPath}/${accountId}/pricing_analytics`, `${versionPath}/${accountId}/pricing_analytics`
	]);
	assert.equal(calls[0]?.url.searchParams.get("fields"), "currency");
	for (const call of calls.slice(1)) {
		assert.equal(call.url.searchParams.get("start"), String(pricingFrom.getTime() / 1000));
		assert.equal(call.url.searchParams.get("end"), String(pricingTo.getTime() / 1000));
		assert.equal(call.url.searchParams.get("phone_numbers"), JSON.stringify([pricingPhone]));
		assert.equal(call.url.searchParams.get("metric_types"), '["COST","VOLUME"]');
		assert.equal(call.url.searchParams.get("dimensions"), '["PHONE","PRICING_CATEGORY","PRICING_TYPE"]');
		assert.equal(new Headers(call.init.headers).get("authorization"), `Bearer ${token}`);
	}
	assert.equal(calls[2]?.url.searchParams.get("after"), "next-pricing-page");
});

test("retains zero and missing costs distinctly, including incomplete buckets", async () => {
	const { graph } = graphWithReplies(() => json({ currency: "USD" }), () => json({
		data: [{ data_points: [
			marketingPoint,
			{ ...marketingPoint, cost: undefined },
			{ ...marketingPoint, pricing_category: "UTILITY", cost: null },
			{ ...marketingPoint, pricing_category: "SERVICE", pricing_type: "FREE_CUSTOMER_SERVICE", cost: 0 }
		] }]
	}));
	const result = await graph.getPricingAnalytics(accountId, pricingPhone, pricingFrom, pricingTo);
	assert.deepEqual(result, {
		currency: "USD", totalCost: null, totalVolume: 8,
		buckets: [
			{ category: "MARKETING", pricingType: "REGULAR", volume: 4, cost: null },
			{ category: "UTILITY", pricingType: "REGULAR", volume: 2, cost: null },
			{ category: "SERVICE", pricingType: "FREE_CUSTOMER_SERVICE", volume: 2, cost: 0 },
		]
	});
});

test("distinguishes an empty period with a known currency from a missing currency", async () => {
	const empty = graphWithReplies(() => json({ currency: "BRL" }), () => json({ data: [] })).graph;
	assert.deepEqual(await empty.getPricingAnalytics(accountId, pricingPhone, pricingFrom, pricingTo), {
		currency: "BRL", totalCost: 0, totalVolume: 0, buckets: []
	});
	const missing = graphWithReplies(() => json({}), () => json({ data: [{ data_points: [marketingPoint] }] })).graph;
	assert.deepEqual(await missing.getPricingAnalytics(accountId, pricingPhone, pricingFrom, pricingTo), {
		currency: null, totalCost: null, totalVolume: 2,
		buckets: [{ category: "MARKETING", pricingType: "REGULAR", volume: 2, cost: null }]
	});
});

test("rejects unscoped, mismatched or denied pricing requests without exposing upstream credentials", async () => {
	const unused = graphWithReplies();
	await assert.rejects(unused.graph.getPricingAnalytics(accountId, "", pricingFrom, pricingTo), { code: "META_PRICING_PHONE_UNAVAILABLE" });
	assert.equal(unused.calls.length, 0);

	const mismatched = graphWithReplies(() => json({ currency: "BRL" }), () => json({
		data: [{ data_points: [{ ...marketingPoint, phone_number: "551100000001" }] }]
	})).graph;
	await assert.rejects(mismatched.getPricingAnalytics(accountId, pricingPhone, pricingFrom, pricingTo), { code: "META_INVALID_RESPONSE" });

	const denied = graphWithReplies(() => json({ currency: "BRL" }), () => json({
		error: { code: 200, message: `Raw upstream error: ${token}` }
	}, 403)).graph;
	await assert.rejects(denied.getPricingAnalytics(accountId, pricingPhone, pricingFrom, pricingTo), (error: unknown) => {
		assert.ok(error instanceof MetaGraphError);
		assert.equal(error.code, "META_PERMISSION_DENIED");
		assert.doesNotMatch(inspect(error, { depth: 6 }), /Raw upstream error|test-fixture-token-never-log/);
		return true;
	});
});

test("submits positional examples once and never repeats a create whose response was lost", async () => {
	const { graph, calls } = graphWithReplies(() => {
		throw new Error(`Transport disconnected with fixture ${token}`);
	}, () => json({ data: [] }));
	await assert.rejects(graph.createTemplate(accountId, template), (error: unknown) => {
		assert.ok(error instanceof MetaGraphError);
		assert.equal(error.code, "META_WRITE_UNCERTAIN");
		assert.doesNotMatch(inspect(error, { depth: 6 }), new RegExp(token));
		return true;
	});
	assert.equal(calls.length, 2);
	const writes = calls.filter((call) => call.init.method === "POST");
	assert.equal(writes.length, 1);
	const [write] = writes;
	assert.ok(write);
	assert.equal(write.url.pathname, `${versionPath}/${accountId}/message_templates`);
	assert.equal(typeof write.init.body, "string");
	const input = JSON.parse(String(write.init.body));
	assert.equal(input.name, template.name);
	assert.equal(input.language, template.language);
	assert.equal(input.category, template.category);
	assert.deepEqual(input.components, [
		{ type: "BODY", text: template.body, example: { body_text: [template.examples] } },
	]);
});

test("reconciles a lost template submission from an exact match without posting again", async () => {
	const { graph, calls } = graphWithReplies(() => json({}, 503), () => json({
		data: [{
			id: "7991", name: template.name, language: template.language, category: template.category,
			status: "PENDING", components: [{ type: "BODY", text: template.body }],
		}],
	}));
	const result = await graph.createTemplate(accountId, template);
	assert.equal(result.id, "7991");
	assert.equal(result.status, "PENDING");
	assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
	assert.equal(calls[1]?.url.searchParams.get("name"), template.name);
	assert.equal(calls[1]?.url.searchParams.get("language"), template.language);
});

test("retains structured Graph identifiers without leaking raw provider errors or credentials", async () => {
	const { graph } = graphWithReplies(() => json({
		error: { code: 190, fbtrace_id: "GraphTraceFixture", message: `Raw upstream OAuth error ${token}` },
	}, 400));
	await assert.rejects(graph.listTemplates(accountId, {}), (error: unknown) => {
		assert.ok(error instanceof MetaGraphError);
		assert.equal(error.status, 502);
		assert.equal(error.code, "META_PERMISSION_DENIED");
		assert.equal(error.traceId, "GraphTraceFixture");
		assert.doesNotMatch(inspect(error, { depth: 6 }), /Raw upstream OAuth error|test-fixture-token-never-log/);
		return true;
	});
});

test("updates only the fields supplied for the selected phone and preserves the explicit clearing values", async () => {
	const { graph, calls } = graphWithReplies(() => json({ success: true }), () => json({ data: [{ about: "Novo" }] }));
	await graph.updateProfile(phoneId, { about: "Novo", description: "", websites: [] });
	const [write] = calls;
	assert.ok(write);
	assert.equal(write.url.pathname, `${versionPath}/${phoneId}/whatsapp_business_profile`);
	assert.equal(write.init.method, "POST");
	assert.deepEqual(JSON.parse(String(write.init.body)), {
		messaging_product: "whatsapp",
		about: "Novo",
		description: "",
		websites: [],
	});
});

test("uploads the photo's bytes against the signed upload ID, then attaches the returned handle to the phone", async () => {
	const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0xff, 0xd9]);
	const handle = "4::fake-graph-photo-handle";
	const signedSession = "upload:localfixture=?sig=graph-sig";
	const { graph, calls } = graphWithReplies(
		() => json({ id: signedSession }),
		() => json({ h: handle }),
		() => json({ success: true }),
		() => json({ data: [{ profile_picture_url: "https://pps.whatsapp.net/localfixture" }] }),
	);
	await graph.updatePhoto(phoneId, { bytes: photo, contentType: "image/jpeg" });
	const [session, upload, attach, readBack] = calls;
	assert.ok(session && upload && attach && readBack);
	assert.equal(session.url.pathname, `${versionPath}/app/uploads/`);
	assert.equal(new Headers(session.init.headers).get("authorization"), `OAuth ${token}`);
	for (const request of [attach, readBack]) {
		assert.equal(new Headers(request.init.headers).get("authorization"), `Bearer ${token}`);
	}
	assert.equal(session.url.searchParams.get("file_length"), String(photo.length));
	assert.equal(session.url.searchParams.get("file_type"), "image/jpeg");
	assert.equal(upload.url.pathname, `${versionPath}/upload:localfixture=`);
	assert.equal(upload.url.searchParams.get("sig"), "graph-sig");
	const uploadHeaders = new Headers(upload.init.headers);
	assert.equal(uploadHeaders.get("authorization"), `OAuth ${token}`);
	assert.equal(uploadHeaders.get("file_offset"), "0");
	assert.equal(uploadHeaders.get("content-type"), "image/jpeg");
	assert.ok(upload.init.body instanceof Uint8Array);
	assert.deepEqual(Buffer.from(upload.init.body), photo);
	assert.equal(attach.url.pathname, `${versionPath}/${phoneId}/whatsapp_business_profile`);
	assert.deepEqual(JSON.parse(String(attach.init.body)), {
		messaging_product: "whatsapp", profile_picture_handle: handle,
	});
});

test("rejects unexpected upload session URLs before sending image bytes or changing the profile", async () => {
	const { graph, calls } = graphWithReplies(() => json({ id: "https://wrong.example/receipt" }));
	await assert.rejects(graph.updatePhoto(phoneId, { bytes: Buffer.alloc(10), contentType: "image/png" }));
	assert.equal(calls.length, 1);
});
