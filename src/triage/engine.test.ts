import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceTriage, createTriageTemplate, inTriageHours, simulateTriage, summarizeTriageAnswers, validateTriageDefinition,
	type TriageDefinition, type TriageNode } from "./engine";

const sectors = [11, 12, 13];
const template = () => createTriageTemplate({ sales: 11, support: 12, fallback: 13 });
const now = new Date("2026-11-25T13:00:00Z");
const handoff = (id: string, sectorId: number): TriageNode => ({ id, type: "handoff", title: id, sectorId });
const using = (nodes: TriageNode[]): TriageDefinition => ({ ...template(), entry: nodes[0]!.id, nodes });
const question: TriageNode = { id: "nome", type: "question", title: "Nome", text: "Qual é o seu nome?", next: "cond" };
const condition: TriageNode = { id: "cond", type: "condition", title: "É a Júlia?", answerKey: "nome", equals: "Júlia", yes: "a", no: "b" };

test("o modelo pode ficar pendente no rascunho e exige setores válidos para publicar", () => {
	assert.deepEqual(validateTriageDefinition(template(), sectors), []);
	assert.deepEqual(validateTriageDefinition(createTriageTemplate(), sectors).map((issue) => issue.field), ["fallbackSectorId", "sectorId", "sectorId"]);
	assert.deepEqual(validateTriageDefinition(template(), [11, 12]).map((issue) => issue.field), ["fallbackSectorId"]);
	const invalid = { ...template(), nodes: [null], schedule: { timezone: "fuso/inexistente", days: [] } };
	assert.ok(validateTriageDefinition(invalid, sectors).some((issue) => issue.field === "schedule.timezone"));
	assert.ok(validateTriageDefinition(invalid, sectors).some((issue) => issue.field === "id"));
});

test("simulador e atendimento percorrem os mesmos caminhos, por número ou rótulo", () => {
	const definition = template();
	const start = advanceTriage(definition, null, { type: "start", text: "Olá" }, now);
	assert.deepEqual(start.visited, ["inicio", "area"]);
	assert.match(start.messages[1]!, /1\. Vendas\n2\. Suporte/);
	assert.deepEqual(start.state.answers, {});
	for (const [input, sector, choice] of [["2", 12, "Suporte"], ["  vÉnDas  ", 11, "Vendas"]] as const) {
		const reply = { type: "reply", text: input } as const;
		const questionTurn = advanceTriage(definition, start.state, reply, now);
		const detail = {type: "reply", text: "Orçamento do produto"} as const;
		const turn = advanceTriage(definition, questionTurn.state, detail, now);
		assert.deepEqual(simulateTriage(definition, [reply, detail], now), [start, questionTurn, turn]);
		assert.deepEqual(turn.handoff, { sectorId: sector, reason: "configured" });
		assert.deepEqual(summarizeTriageAnswers(definition, turn.state), [{ label: "Área escolhida", value: choice },
			{label: choice === "Suporte" ? "Descrição do problema" : "Produto de interesse", value: detail.text}]);
		assert.deepEqual(start.state.answers, {});
		assert.deepEqual(advanceTriage(definition, turn.state, reply, now).messages, []);
		assert.equal(advanceTriage(definition, turn.state, reply, now).handoff, null);
	}
});

test("o exemplo informa o expediente atual e mantém a área escolhida pelo cliente fora de horário", () => {
	const definition = template();
	definition.schedule.days = [{day:2,start:"10:00",end:"14:00"}];
	for (const [choice, sectorId] of [["Vendas",11],["Suporte",12]] as const) {
		const turns = simulateTriage(definition, [{type:"reply",text:choice},{type:"reply",text:"Quero ajuda"}], now);
		assert.match(turns[0]!.messages[0]!, /digite atendente a qualquer momento/i);
		assert.match(turns[1]!.messages[0]!, choice === "Vendas" ? /produto/i : /problema/i);
		assert.deepEqual(turns[2]!.handoff, {sectorId, reason:"configured"});
		assert.match(turns[2]!.messages[0]!, /terça, das 10:00 às 14:00/);
		assert.ok(turns[2]!.messages[0]!.includes(choice));
	}
});

test("texto é preservado no resumo e comparação ignora espaço, caixa e acentuação", () => {
	const flow = using([question, condition, handoff("a", 11), handoff("b", 12)]);
	assert.deepEqual(validateTriageDefinition(flow, sectors), []);
	const answer = (text: string) => simulateTriage(flow, [{ type: "reply", text }], now)[1]!;
	assert.deepEqual(answer(" Julia ").handoff, { sectorId: 11, reason: "configured" });
	assert.deepEqual(answer("ANDRÉ").handoff, { sectorId: 12, reason: "configured" });
	assert.deepEqual(summarizeTriageAnswers(flow, answer("André").state), [{ label: "Nome", value: "André" }]);
	assert.equal(answer(" ").state.invalidAttempts, 1);
});

test("opções inválidas e pedido de pessoa encaminham para a contingência", () => {
	const flow = template();
	const invalid = { type: "reply", text: "99" } as const;
	const turns = simulateTriage(flow, [invalid, invalid], now);
	assert.equal(turns[1]!.state.invalidAttempts, 1);
	assert.match(turns[1]!.messages[0]!, /2\. Suporte/);
	assert.deepEqual(turns[2]!.handoff, { sectorId: 13, reason: "invalid" });
	assert.equal(turns[2]!.state.deadline, null);
	assert.deepEqual(simulateTriage(flow, [{ type: "reply", text: "Falar com atendente!" }], now)[1]!.handoff, { sectorId: 13, reason: "requested" });
	assert.deepEqual(advanceTriage(flow, null, { type: "start", text: "atendente" }, now).handoff, { sectorId: 13, reason: "requested" });
});

test("tempo de espera é determinístico e ingressos tardios seguem o mesmo destino do timer", () => {
	const flow = template();
	const start = advanceTriage(flow, null, { type: "start" }, now);
	assert.equal(advanceTriage(flow, start.state, { type: "timeout" }, now).handoff, null);
	const timeout = simulateTriage(flow, [{ type: "timeout" }], now)[1]!;
	assert.deepEqual(timeout.handoff, { sectorId: 13, reason: "timeout" });
	assert.deepEqual(timeout, advanceTriage(flow, start.state, { type: "reply", text: "1" }, new Date(start.state.deadline!)));
	assert.throws(() => simulateTriage(flow, [{ type: "timeout", at: "2026-11-24T10:00:00Z" }], now), /cronológica/);
	assert.throws(() => simulateTriage(flow, [{ type: "timeout", at: "2026-11-25T23:00" }], now), /fuso/);
});

test("horário local respeita limites, meia-noite, virada da semana e horário de verão", () => {
	const schedule = { timezone: "America/Sao_Paulo", days: [{ day: 6, start: "22:00", end: "02:00" }] };
	const flow = using([{ id: "horario", type: "hours", title: "Aberto?", yes: "a", no: "b" }, handoff("a", 11), handoff("b", 12)]);
	flow.schedule = schedule;
	assert.deepEqual(validateTriageDefinition(flow, sectors), []);
	const at = (utc: string) => simulateTriage(flow, [], new Date(utc))[0]!.handoff?.sectorId;
	assert.equal(at("2026-11-29T00:59:00Z"), 12);
	assert.equal(at("2026-11-29T01:00:00Z"), 11);
	assert.equal(at("2026-11-29T04:59:59Z"), 11);
	assert.equal(at("2026-11-29T05:00:00Z"), 12);
	const berlin = { timezone: "Europe/Berlin", days: [{ day: 1, start: "09:00", end: "17:00" }] };
	assert.ok(inTriageHours(berlin, new Date("2026-06-01T07:00:00Z")));
	assert.equal(inTriageHours(berlin, new Date("2026-12-07T07:00:00Z")), false);
});

test("validação localiza ligação quebrada, ramos sem saída, ciclos imediatos e resposta ausente", () => {
	const broken = template();
	broken.nodes[0]!.next = "ausente";
	assert.ok(validateTriageDefinition(broken, sectors).some((issue) => issue.nodeId === "inicio" && issue.field === "next"));
	const cycle = using([{ id: "x", type: "message", title: "A", text: "A", next: "x" }, handoff("a", 11)]);
	const issues = validateTriageDefinition(cycle, sectors);
	assert.ok(issues.some((issue) => issue.nodeId === "x" && /sem aguardar/.test(issue.message)));
	assert.ok(issues.some((issue) => issue.nodeId === "a" && /alcançada/.test(issue.message)));
	const firstIsCondition = using([condition, question, handoff("a", 11), handoff("b", 12)]);
	assert.ok(validateTriageDefinition(firstIsCondition, sectors).some((issue) => issue.nodeId === "cond" && issue.field === "answerKey"));
	const menuCycle = template();
	menuCycle.nodes[1]!.options![0]!.next = "area";
	menuCycle.nodes = menuCycle.nodes.filter((node) => !node.id.includes("vendas"));
	assert.deepEqual(validateTriageDefinition(menuCycle, sectors), []);
});

test("validação rejeita chaves reservadas, escolhas ambíguas e destinos de outra empresa", () => {
	const flow = template();
	const menu = flow.nodes[1]!;
	menu.answerKey = "constructor";
	menu.options![1]!.label = " vÉnDas ";
	assert.ok(validateTriageDefinition(flow, sectors).some((issue) => issue.field === "answerKey"));
	assert.ok(validateTriageDefinition(flow, sectors).some((issue) => issue.field === "options"));
	assert.ok(validateTriageDefinition(flow, [11, 13]).some((issue) => issue.nodeId === "suporte" && issue.field === "sectorId"));
});
