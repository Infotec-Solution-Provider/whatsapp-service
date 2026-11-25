import assert from "node:assert/strict";
import type { TriageTriggers } from "./triggers";

/** Runs against each authoring fixture (shared central database and isolated native tenant). */
export async function exerciseBotTriggers(base: string, service: TriageTriggers, versionId: number) {
	async function api(method: string, path: string, body?: unknown, who = "admin", status = 200) {
		const response = await fetch(base + path, {
			method,
			headers: { authorization: who, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
		const payload = (await response.json()) as { data?: any; message?: string };
		assert.equal(response.status, status, method + " " + path + ": " + (payload.message ?? ""));
		return payload.data;
	}
	const sector = "/sectors/10",
		path = sector + "/bot-triggers";
	const expected = { botId: 1, channelId: 1, channelName: "Principal", name: "Recepção", version: 1, versionId };
	assert.deepEqual(await api("GET", sector + "/bots"), { bots: [expected] });
	assert.deepEqual(await api("GET", path), { revision: 0, rules: [], bots: [expected] });
	await api("GET", path, undefined, "supervisor", 403);
	await api("GET", path, undefined, "outsider", 404);
	await api("PUT", path, {}, "external", 403);
	const rules = [
		{ type: "keyword", botId: 1, keywords: ["Orçamento Geral", "vendas"] },
		{ type: "manual", botId: 1 },
		{ type: "transfer", botId: 1 },
		{ type: "closed", botId: 1 }
	];
	for (const invalidRules of [
		[{ type: "manual", botId: 3 }],
		[{ type: "manual", botId: 2 }],
		[{ type: "keyword", botId: 1, keywords: ["Ação", "acao"] }],
		[rules[1], rules[1]],
		[{ type: "codigo", botId: 1 }],
		[{ type: "manual", botId: 1, instance: "beta" }]
	])
		await api("PUT", path, { revision: 0, rules: invalidRules }, "admin", 422);
	for (const rule of rules) {
		const input = {
			rules,
			channelId: 1,
			type: rule.type,
			...(rule.type === "keyword" && { text: " orcamento    GERAL  " })
		};
		assert.deepEqual(await api("POST", path + "/simulate", input), { matched: true, bot: expected });
	}
	assert.deepEqual(
		await api("POST", path + "/simulate", { rules, channelId: 1, type: "keyword", text: "quero orçamento geral" }),
		{ matched: false, bot: null }
	);
	assert.equal((await api("GET", path)).revision, 0);
	const race = await Promise.all(
		[1, 2].map(() =>
			fetch(base + path, {
				method: "PUT",
				headers: { authorization: "admin", "Content-Type": "application/json" },
				body: JSON.stringify({ revision: 0, rules })
			})
		)
	);
	assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
	await Promise.all(race.map((r) => r.text()));
	assert.deepEqual((await api("GET", path)).rules, rules);
	assert.equal((await api("PUT", path, { revision: 1, rules })).revision, 1);
	for (const type of ["keyword", "manual", "transfer", "closed"] as const) {
		assert.deepEqual(await service.match("alpha", 1, { type, sectorId: 10, text: " ORCAMENTO  geral " }), {
			botId: 1,
			versionId,
			sectorId: 10
		});
		assert.equal(await service.match("beta", 1, { type, sectorId: 10, text: "vendas" }), null);
		assert.equal(await service.match("alpha", 3, { type, sectorId: 10, text: "vendas" }), null);
	}
	assert.equal(await service.match("alpha", 1, { type: "manual" }), null);
	assert.deepEqual(await service.match("alpha", 1, { type: "keyword", text: "vendas" }), {
		botId: 1,
		versionId,
		sectorId: 10
	});
	await api("PUT", "/sectors/11/bot-triggers", { revision: 0, rules: [rules[0]] });
	assert.equal(await service.match("alpha", 1, { type: "keyword", text: "vendas" }), null);
	assert.deepEqual(await service.match("alpha", 1, { type: "keyword", text: "vendas", sectorId: 11 }), {
		botId: 1,
		versionId,
		sectorId: 11
	});
	await api("PUT", "/sectors/11/bot-triggers", { revision: 1, rules: [] });
	assert.deepEqual(await service.match("alpha", 1, { type: "keyword", text: "vendas" }), {
		botId: 1,
		versionId,
		sectorId: 10
	});
}
