import "express-async-errors";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express, { type RequestHandler } from "express";
import { META_MANAGEMENT_PARAMETER } from "../parameters/meta-management";
import { MetaManagementGraph } from "../services/meta-management.graph";
import type { DatabaseClient } from "../services/prisma.service";
import { currentDatabaseTenant, withDatabaseTenant } from "../utils/database-tenant-context";

function link(id: number, instance: string, account: string, phoneId: string, isActive = true, type = "WABA", token: string | null = `mock-channel-token-${id}`) {
	return { id, name: `Canal ${id}`, phone: null, instance, type, isActive, WABAAccountId: account, WABAPhoneId: phoneId, WABAToken: token };
}

const channels = [
	link(1, "tenant-a", "100", "101"),
	link(2, "tenant-a", "200", "201"),
	link(3, "tenant-b", "200", "202", false),
	link(4, "tenant-a", "300", "301"),
	link(5, "tenant-b", "400", "301", false),
	link(6, "tenant-a", "600", "601", true, "GUPSHUP"),
	link(7, "tenant-b", "700", "701"),
	link(8, "tenant-a", "800", "801", true, "WABA", null),
	link(9, "tenant-a", "100", "109"),
	link(10, "tenant-a", "100", "110", false),
	link(11, "tenant-a", "100", "111"),
	link(12, "tenant-a", "800", "802", true, "WABA", ""),
	link(13, "tenant-a", "800", "invalid")
];
const flagReads: string[] = [];
const channelReads: number[] = [];

function projection(row: Record<string, unknown>, select: Record<string, boolean>) {
	return Object.fromEntries(Object.entries(row).filter(([key]) => select[key]));
}

function localChannels(where: Record<string, unknown>) {
	assert.equal(currentDatabaseTenant(), where["instance"]);
	assert.equal(where["type"], "WABA");
	assert.equal(where["isActive"], true);
	assert.deepEqual(where["AND"], [{ WABAToken: { not: null } }, { WABAToken: { not: "" } }]);
	return channels.filter((row) => row.instance === where["instance"] && row.type === "WABA" && row.isActive && row.WABAToken);
}

const database = {
	parameter: {
		findFirst: async ({ where }: { where: Record<string, unknown> }) => {
			assert.deepEqual(where, {
				instance: where["instance"], scope: "INSTANCE", key: META_MANAGEMENT_PARAMETER, userId: null, sectorId: null
			});
			flagReads.push(String(where["instance"]));
			return where["instance"] === "tenant-a" ? { value: "true" } : null;
		}
	},
	wppClient: {
		findFirst: async ({ where, select }: { where: Record<string, unknown>; select: Record<string, boolean> }) => {
			assert.equal(typeof where["id"], "number");
			assert.equal(select["WABAToken"], true);
			const id = where["id"] as number;
			channelReads.push(id);
			const row = localChannels(where).find((candidate) => candidate.id === id);
			return row ? projection(row, select) : null;
		},
		findMany: async ({ where, select }: { where: Record<string, unknown>; select: Record<string, boolean> }) => {
			let rows: typeof channels;
			if (typeof where["instance"] === "string") {
				assert.equal(currentDatabaseTenant(), where["instance"]);
				if (where["type"]) {
					assert.equal(select["WABAToken"], undefined);
					rows = localChannels(where);
				}
				else {
					assert.deepEqual(select, { WABAAccountId: true, WABAPhoneId: true });
					const accounts = where["WABAAccountId"] as { in: string[] };
					rows = channels.filter((row) => row.instance === where["instance"] && accounts.in.includes(row.WABAAccountId));
				}
			} else {
				assert.equal(currentDatabaseTenant(), null);
				assert.deepEqual(select, { WABAAccountId: true, WABAPhoneId: true });
				const instance = where["instance"] as { not: string };
				const [accounts, phones] = where["OR"] as [{ WABAAccountId: { in: string[] } }, { WABAPhoneId: { in: string[] } }];
				rows = channels.filter((row) => row.instance !== instance.not &&
					(accounts.WABAAccountId.in.includes(row.WABAAccountId) || phones.WABAPhoneId.in.includes(row.WABAPhoneId)));
			}
			return rows.map((row) => projection(row, select));
		}
	}
};

const graphRequests: Array<{ method: string; path: string; credential: string | null }> = [];
const logEvents: unknown[] = [];
const graphFetch: typeof fetch = async (input, options) => {
	const path = new URL(String(input)).pathname.split("/").slice(2).join("/");
	const method = options?.method ?? "GET";
	const credential = new Headers(options?.headers).get("Authorization");
	graphRequests.push({ method, path, credential });
	if (path === "100/phone_numbers") return Response.json({ data: [
		{ id: "101", display_phone_number: "+550000000001", status: "CONNECTED" },
		{ id: "109", display_phone_number: "+550000000009", verified_name: "Outro número", quality_rating: "GREEN" },
		{ id: "199", verified_name: "Unlinked asset" }
	] });
	if (path === "101/whatsapp_business_profile") return Response.json({ data: [{ about: "Perfil autorizado" }] });
	if (path === "109/whatsapp_business_profile") return method === "POST"
		? Response.json({ success: true }) : Response.json({ data: [{ about: "Perfil alterado" }] });
	if (path === "100/message_templates") return method === "POST"
		? Response.json({ id: "900", status: "PENDING", category: "UTILITY" }) : Response.json({ data: [] });
	assert.fail(`unexpected mock path: ${path}`);
};

function graphCall(id: number, path: string, method = "GET") {
	return { method, path, credential: `Bearer mock-channel-token-${id}` };
}

const authenticate: RequestHandler = (req, res, next) => {
	const token = req.headers.authorization;
	if (!token) { res.status(401).json({ message: "Unauthorized" }); return; }
	req.session = {
		instance: token === "Bearer disabled" ? "tenant-disabled" : "tenant-a", userId: 7, sectorId: 1,
		role: token === "Bearer operator" ? "USER" : "ADMIN", name: "Fixture"
	};
	withDatabaseTenant(req.session.instance, next);
};

const overrides = new Map<string, NodeModule | undefined>();
function stub(modulePath: string, value: unknown) {
	const filename = require.resolve(modulePath);
	overrides.set(filename, require.cache[filename]);
	require.cache[filename] = { id: filename, filename, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
}

stub("../services/prisma.service", database);
stub("../middlewares/is-authenticated.middleware", authenticate);
stub("../utils/processing-logger", class {
	constructor(instance: string, action: string, _id: string, metadata: unknown) { logEvents.push({ instance, action, metadata }); }
	success(result: unknown) { logEvents.push(result); }
	failed(error: unknown) { logEvents.push(error); }
});
const { MetaManagementService } = require("../services/meta-management.service") as typeof import("../services/meta-management.service");
stub("../services/meta-management.service", new MetaManagementService(
	database as unknown as Pick<DatabaseClient, "wppClient">,
	(token) => new MetaManagementGraph(token, graphFetch),
	async () => null
));
const costCalls: unknown[] = [];
stub("../services/meta-costs.service", {
	getCosts: async (instance: string, { month }: { month: string }) => ({ instance, month }),
	getOfficialCosts: async (instance: string, clientId: number, { month }: { month: string }) => ({
		instance, clientId, month
	}),
	setBudget: async (session: { instance: string; userId: number }, month: string, operatorId: number, budgetCents: number | null) => {
		costCalls.push({ instance: session.instance, actor: session.userId, month, operatorId, budgetCents });
		return { budgetCents };
	}
});
const router = (require("./meta-management.controller") as typeof import("./meta-management.controller")).default;
for (const [filename, previous] of overrides) {
	if (previous) require.cache[filename] = previous;
	else delete require.cache[filename];
}

test("Meta routes require ADMIN and instance opt-in, then enforce exclusive WABA and phone ownership", async () => {
	const app = express().use("/api/whatsapp/meta", router);
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as { port: number };
	const base = `http://127.0.0.1:${port}/api/whatsapp/meta`;
	const admin = { Authorization: "Bearer admin" };
	try {
		for (const [method, path] of [
			["GET", "/channels"], ["GET", "/channels/1/templates"], ["POST", "/channels/1/templates"],
			["GET", "/channels/1/number"], ["GET", "/numbers/1/profile"], ["PATCH", "/numbers/1/profile"], ["POST", "/numbers/1/photo"]
		] as const) {
			assert.equal((await fetch(`${base}${path}`, { method })).status, 401);
		}
		assert.equal((await fetch(`${base}/channels`, { headers: { Authorization: "Bearer operator" } })).status, 403);
		assert.deepEqual(flagReads, []);
		const disabled = await fetch(`${base}/numbers/1/photo`, {
			method: "POST", headers: { Authorization: "Bearer disabled", "Content-Type": "multipart/form-data" }
		});
		assert.equal(disabled.status, 403);
		assert.equal((await disabled.json() as { code: string }).code, "META_MANAGEMENT_DISABLED");

		const directory = await fetch(`${base}/channels?instance=tenant-b`, { headers: admin });
		assert.equal(directory.status, 200);
		assert.deepEqual(await directory.json(), { channels: [
			{ clientId: 1, name: "Canal 1", phone: null }, { clientId: 9, name: "Canal 9", phone: null }, { clientId: 11, name: "Canal 11", phone: null }
		] });
		assert.deepEqual(channelReads, []);
		for (const path of ["/accounts", "/channels/2/templates", "/channels/4/number", "/channels/6/templates", "/channels/7/templates",
			"/numbers/4/profile", "/numbers/7/profile", "/numbers/8/profile", "/numbers/10/profile", "/channels/12/number", "/channels/13/number"]) {
			assert.equal((await fetch(`${base}${path}`, { headers: admin })).status, 404, path);
		}
		assert.deepEqual(graphRequests, []);

		const mismatch = await fetch(`${base}/channels/11/templates`, { headers: admin });
		assert.equal(mismatch.status, 409);
		assert.deepEqual(graphRequests.splice(0), [graphCall(11, "100/phone_numbers")]);

		const number = await fetch(`${base}/channels/9/number`, { headers: admin });
		assert.equal(number.status, 200);
		assert.deepEqual(await number.json(), { number: {
			clientId: 9, name: "Canal 9", phone: "+550000000009", verifiedName: "Outro número", status: null, qualityRating: "GREEN"
		} });
		assert.deepEqual(graphRequests.splice(0), [graphCall(9, "100/phone_numbers")]);

		for (const channelId of [1, 9]) {
			const catalog = await fetch(`${base}/channels/${channelId}/templates`, { headers: admin });
			assert.equal(catalog.status, 200);
			assert.deepEqual(await catalog.json(), { templates: [], nextCursor: null });
			assert.deepEqual(graphRequests.splice(0), [graphCall(channelId, "100/phone_numbers"), graphCall(channelId, "100/message_templates")]);
		}

		const created = await fetch(`${base}/channels/9/templates`, {
			method: "POST", headers: { ...admin, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "aviso", category: "UTILITY", language: "pt_BR", body: "Conteúdo de teste", examples: [] })
		});
		assert.equal(created.status, 201);
		assert.deepEqual(graphRequests.splice(0), [graphCall(9, "100/phone_numbers"), graphCall(9, "100/message_templates", "POST")]);

		const profile = await fetch(`${base}/numbers/1/profile`, { headers: admin });
		assert.equal(profile.status, 200);
		assert.equal((await profile.json() as { profile: { about: string } }).profile.about, "Perfil autorizado");
		assert.deepEqual(graphRequests.splice(0), [graphCall(1, "100/phone_numbers"), graphCall(1, "101/whatsapp_business_profile")]);
		const patch = await fetch(`${base}/numbers/9/profile`, {
			method: "PATCH", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ about: "Perfil alterado" })
		});
		assert.equal(patch.status, 200);
		assert.deepEqual(graphRequests.splice(0), [graphCall(9, "100/phone_numbers"), graphCall(9, "109/whatsapp_business_profile", "POST"), graphCall(9, "109/whatsapp_business_profile")]);
		assert.doesNotMatch(JSON.stringify(logEvents), /mock-channel-token|Conteúdo de teste|Perfil alterado/);

		const malformedPhoto = await fetch(`${base}/numbers/1/photo`, {
			method: "POST", headers: { ...admin, "Content-Type": "multipart/form-data" }, body: "malformed"
		});
		assert.equal(malformedPhoto.status, 400);
		assert.deepEqual(graphRequests, []);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});


test("cost routes use authenticated tenant scope and validate budgets before mutation", async () => {
	const app = express().use("/api/whatsapp/meta", router);
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as { port: number };
	const base = `http://127.0.0.1:${port}/api/whatsapp/meta`;
	const headers = { Authorization: "Bearer admin", "Content-Type": "application/json" };
	const updateBudget = (id: string, value: unknown, authorization = headers.Authorization) =>
		fetch(`${base}/budgets/${id}?month=2026-11`, {
			method: "PUT", headers: { ...headers, Authorization: authorization }, body: JSON.stringify(value)
		});
	try {
		const costs = await fetch(`${base}/costs?month=2026-11`, { headers });
		assert.equal(costs.headers.get("Cache-Control"), "no-store");
		assert.deepEqual(await costs.json(), { instance: "tenant-a", month: "2026-11" });
		const report = await fetch(`${base}/channels/1/costs?month=2026-11`, { headers });
		assert.deepEqual(await report.json(), { instance: "tenant-a", clientId: 1, month: "2026-11" });
		assert.equal((await fetch(`${base}/costs?month=2026-31`, { headers })).status, 400);
		assert.equal((await updateBudget("12", { budgetCents: 1100 }, "Bearer operator")).status, 403);
		assert.equal((await updateBudget("12", { budgetCents: 1100 }, "Bearer disabled")).status, 403);
		assert.equal((await updateBudget("0", { budgetCents: 1100 })).status, 400);
		assert.equal((await updateBudget("12", { budgetCents: "1100" })).status, 400);
		assert.deepEqual(await (await updateBudget("12", { budgetCents: 0, instance: "tenant-b" })).json(), { budgetCents: 0 });
		assert.deepEqual(await (await updateBudget("12", { budgetCents: null })).json(), { budgetCents: null });
		assert.deepEqual(costCalls, [
			{ instance: "tenant-a", actor: 7, month: "2026-11", operatorId: 12, budgetCents: 0 },
			{ instance: "tenant-a", actor: 7, month: "2026-11", operatorId: 12, budgetCents: null }
		]);
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});


test("the isolated WABA can list templates and only creates them with explicit management opt-in", async () => {
	const inactive = { ...channels.find(row => row.id === 10)!, WABAToken: null, WABAAccountId: null, WABAPhoneId: null };
	const scopedDb = {
		wppClient: {
			findMany: async (args: { where: Record<string, unknown>; select: Record<string, boolean> }) => {
				if (args.where["type"] === "WABA") {
					assert.deepEqual(args.where["OR"], [
						{ type: "WABA", AND: [{ WABAToken: { not: null } }, { WABAToken: { not: "" } }], isActive: true, id: { not: 10 } },
						{ id: 10, isActive: false, WABAToken: null, WABAAccountId: null, WABAPhoneId: null }
					]);
					return [channels[0]!, inactive].map(row => projection(row, args.select));
				}
				return database.wppClient.findMany(args);
			},
			findFirst: async ({ where, select }: { where: Record<string, unknown>; select: Record<string, boolean> }) => {
				assert.equal(currentDatabaseTenant(), "tenant-a");
				assert.equal(where["isActive"], false);
				assert.equal(where["WABAToken"], null);
				assert.equal(where["WABAAccountId"], null);
				assert.equal(where["WABAPhoneId"], null);
				assert.equal(where["id"], 10);
				return projection(inactive, select);
			}
		}
	};
	const requests: Array<[string, string]> = [];
	const graph: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const endpoint = url.pathname.split("/").slice(2).join("/");
		requests.push([init?.method ?? "GET", endpoint]);
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-pricing-credential");
		if (endpoint === "100/phone_numbers") {
			return Response.json({ data: [{ id: "110", display_phone_number: "+55 11 91234-5678" }] });
		}
		if (endpoint === "100") return Response.json({ currency: "BRL" });
		if (endpoint === "100/pricing_analytics") return Response.json({ data: [] });
		if (endpoint === "100/message_templates") return init?.method === "POST"
			? Response.json({ id: "901", status: "PENDING", category: "UTILITY" })
			: Response.json({ data: [
				{ id: "900", name: "existente", category: "UTILITY", language: "pt_BR", status: "APPROVED", components: [] }
			] });
		assert.fail("Unexpected Graph request");
	};
	const binding = { token: "fixture-pricing-credential", accountId: "100", phoneId: "110" };
	let allowTemplateCreation: boolean | undefined;
	const service = new MetaManagementService(
		scopedDb as unknown as Pick<DatabaseClient, "wppClient">,
		token => new MetaManagementGraph(token, graph),
		async instance => instance === "tenant-a" ? 10 : null,
		async (instance, clientId) => instance === "tenant-a" && clientId === 10
			? { ...binding, ...(allowTemplateCreation === undefined ? {} : { allowTemplateCreation }) }
			: null
	);
	await withDatabaseTenant("tenant-a", async () => {
		const isolatedChannel = { clientId: 10, name: "Canal 10", phone: null, managementMode: "pricing-only" };
		const session = { instance: "tenant-a", role: "ADMIN" as const, userId: 7, sectorId: 1, name: "Fixture" };
		const input = { name: "aviso", category: "UTILITY" as const, language: "pt_BR", body: "Conteúdo de teste", examples: [] };
		assert.deepEqual((await service.listChannels("tenant-a"))[1], { ...isolatedChannel, templateCreationEnabled: false });
		await assert.rejects(() => service.getNumber("tenant-a", 10), { code: "META_CHANNEL_PRICING_ONLY" });
		await assert.rejects(() => service.getProfile("tenant-a", 10), { code: "META_CHANNEL_PRICING_ONLY" });
		await assert.rejects(() => service.createTemplate(session, 10, input), { code: "META_TEMPLATE_CREATION_DISABLED" });
		assert.equal(requests.length, 0);

		const { templates } = await service.listTemplates("tenant-a", 10, {});
		assert.equal(templates[0]?.name, "existente");
		assert.deepEqual(requests.splice(0), [["GET", "100/phone_numbers"], ["GET", "100/message_templates"]]);

		allowTemplateCreation = true;
		assert.deepEqual((await service.listChannels("tenant-a"))[1], { ...isolatedChannel, templateCreationEnabled: true });
		await assert.rejects(() => service.updateProfile(session, 10, { about: "change" }), { code: "META_CHANNEL_PRICING_ONLY" });
		assert.equal(requests.length, 0);
		const created = await service.createTemplate(session, 10, input);
		assert.equal(created.status, "PENDING");
		assert.deepEqual(requests.splice(0), [["GET", "100/phone_numbers"], ["POST", "100/message_templates"]]);
		assert.doesNotMatch(JSON.stringify(logEvents), /fixture-pricing-credential|Conteúdo de teste/);
		const report = await service.getChannelPricing("tenant-a", 10, {
			start: new Date("2026-11-01"), end: new Date("2026-11-02")
		});
		assert.equal(report?.currency, "BRL");
		assert.deepEqual(requests.map(([method]) => method), ["GET", "GET", "GET"]);
		allowTemplateCreation = false;
		await assert.rejects(() => service.createTemplate(session, 10, input), { code: "META_TEMPLATE_CREATION_DISABLED" });
		assert.equal(requests.length, 3);
	});
});
