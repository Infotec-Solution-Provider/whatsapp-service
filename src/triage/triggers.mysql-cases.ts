import assert from "node:assert/strict";
import type { TriageTriggers, TriageCatalogBot } from "./triggers";

/** Runs against each authoring fixture (shared central database and isolated native tenant). */
export async function exerciseBotTriggers(
	base: string,
	service: TriageTriggers,
	primary: TriageCatalogBot,
	second: TriageCatalogBot
) {
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
	const { botId, versionId } = primary;
	const catalog = [second, primary];
	assert.deepEqual(await api("GET", sector + "/bots"), { bots: catalog });
	assert.deepEqual(await api("GET", path), { revision: 0, rules: [], bots: catalog });
	await api("GET", path, undefined, "supervisor", 403);
	await api("GET", path, undefined, "outsider", 404);
	await api("PUT", path, {}, "external", 403);
	const rules = [
		{ type: "keyword", botId, keywords: ["Orçamento Geral", "vendas"] },
		{ type: "manual", botId },
		{ type: "transfer", botId },
		{ type: "closed", botId: second.botId },
		{ type: "manual", botId: second.botId },
		{ type: "keyword", botId: second.botId, keywords: ["Pós-venda"] }
	];
	for (const invalidRules of [
		[{ type: "manual", botId: 1999999999 }],
		[{ type: "keyword", botId, keywords: ["Ação", "acao"] }],
		[...rules, { type: "transfer", botId: second.botId }],
		[...rules, { type: "closed", botId }],
		[rules[0], { type: "keyword", botId: second.botId, keywords: [" Orcamento    GERAL "] }],
		[rules[1], rules[1]],
		[{ type: "codigo", botId }],
		[{ type: "manual", botId, instance: "beta" }]
	])
		await api("PUT", path, { revision: 0, rules: invalidRules }, "admin", 422);
	for (const rule of rules) {
		const input = {
			rules,
			channelId: 1,
			type: rule.type,
			...(rule.type === "keyword" && { text: rule.botId === botId ? " orcamento    GERAL  " : "pos-venda" }),
			...(rule.type === "manual" && { botId: rule.botId })
		};
		assert.deepEqual(await api("POST", path + "/simulate", input), {
			matched: true,
			bot: rule.botId === botId ? primary : second
		});
	}
	assert.deepEqual(
		await api("POST", path + "/simulate", { rules, channelId: 1, type: "keyword", text: "quero orçamento geral" }),
		{ matched: false, bot: null }
	);
	await api("POST", path + "/simulate", { rules, channelId: 1, type: "manual" }, "admin", 422);
	await api(
		"POST",
		path + "/simulate",
		{ rules: [...rules, { type: "closed", botId }], channelId: 1, type: "closed" },
		"admin",
		422
	);
	assert.deepEqual(
		await api("POST", path + "/simulate", { rules, channelId: 2, type: "manual", botId: second.botId }),
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
		const selected = type === "closed" || type === "manual" ? second : primary;
		assert.deepEqual(
			await service.match("alpha", 1, {
				type,
				sectorId: 10,
				text: " ORCAMENTO  geral ",
				...(type === "manual" ? { botId: second.botId } : {})
			}),
			{
				botId: selected.botId,
				versionId: selected.versionId,
				sectorId: 10
			}
		);
		assert.equal(await service.match("beta", 1, { type, sectorId: 10, text: "vendas" }), null);
		assert.equal(await service.match("alpha", 3, { type, sectorId: 10, text: "vendas" }), null);
	}
	assert.deepEqual(
		(await service.manualOptions("alpha", 1, 10)).map((bot) => bot.botId).sort(),
		[primary.botId, second.botId].sort()
	);
	assert.deepEqual(await service.manualOptions("beta", 1, 10), []);
	assert.equal(await service.match("alpha", 1, { type: "manual", sectorId: 10 }), null);
	assert.deepEqual(await service.match("alpha", 1, { type: "keyword", text: "POS-VENDA" }), {
		botId: second.botId,
		versionId: second.versionId,
		sectorId: 10
	});
	assert.equal(await service.match("alpha", 1, { type: "manual" }), null);
	assert.deepEqual(await service.match("alpha", 1, { type: "keyword", text: "vendas" }), {
		botId,
		versionId,
		sectorId: 10
	});
	await api("PUT", "/sectors/11/bot-triggers", { revision: 0, rules: [rules[0]] });
	assert.equal(await service.match("alpha", 1, { type: "keyword", text: "vendas" }), null);
	assert.deepEqual(await service.match("alpha", 1, { type: "keyword", text: "vendas", sectorId: 11 }), {
		botId,
		versionId,
		sectorId: 11
	});
	await api("PUT", "/sectors/11/bot-triggers", { revision: 1, rules: [] });
	assert.deepEqual(await service.match("alpha", 1, { type: "keyword", text: "vendas" }), {
		botId,
		versionId,
		sectorId: 10
	});
}
