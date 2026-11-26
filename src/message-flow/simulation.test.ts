import assert from "node:assert/strict";
import type { WppContact } from "@prisma/client";
import type { UserOnlineSession } from "../sdk-local";
import type { SimulationReads } from "./simulation-reads";
import type { FlowStepDefinition } from "./flow-definition";
import { buildOdimInboundFlow } from "./configurations/odim-inbound";

// Real workflow steps and resolver with only announced reads. Every accidental production write/network call is a test failure.
let resolutionLookups = 0;
let unexpected = 0;
function forbidden(): never { unexpected++; throw Error("Unexpected runtime dependency"); }
const mock = (path: string, exports: object) => { require.cache[require.resolve(path)] = { exports } as NodeModule; };
mock("../services/prisma.service", { __esModule: true, default: new Proxy({}, { get: forbidden }) });
mock("../services/auth.service", { __esModule: true, default: { getOnlineSessions: forbidden } });
mock("../services/contact-customer-resolution.runtime", { resolveContactCustomerForFlow: forbidden });
mock("../services/instances.service", { __esModule: true, default: {
	async executeQuery(tenant: string, sql: string) {
		if (tenant !== "test" || !sql.startsWith("SELECT DISTINCT candidate.customer_id")) return forbidden();
		resolutionLookups++;
		return [{ customer_id: 404 }];
	}
} });
const { simulateMessageFlow, FlowSimulationError } = require("./simulation") as typeof import("./simulation");
const { simulationReads } = require("./simulation-reads") as typeof import("./simulation-reads");
const { registerAllSteps } = require("./register-steps") as typeof import("./register-steps");
registerAllSteps();

const sector = 101;
const tenant = "test";
const contact = Object.freeze({ instance: tenant, id: 7, customerId: null, isOnlyAdmin: false, isDeleted: false,
	phone: "5511987654321", whatsappId: "5511987654321@c.us", name: "Contato" }) as WppContact;
const people = [11, 22, 33].map((id, index) => ({ CODIGO: id, NOME: `Nome ${id}`, NIVEL: index === 1 ? "ADMIN" : "AMBOS", ATIVO: "SIM", SETOR: sector }));
const session = (id: number): UserOnlineSession => ({
	data: { instance: tenant, name: "", role: "AMBOS", sectorId: sector, userId: id }, isPaused: false, onlineTokens: ["online"]
});
const base: SimulationReads = {
	previewBot: async (instance, sectorId, channelId, botId) => instance === tenant && sectorId === sector && channelId === 9 && botId === 9
		? { id: botId, name: "Recepção", version: 3 } : null,
	contact: async () => contact, resolveCustomer: simulationReads.resolveCustomer,
	sessions: async () => [session(11), session(22)], eligible: async (_instance, ids) => new Set(ids),
	chatCounts: async () => new Map([[11, 7], [22, 1]]), loyalty: async () => 33,
	operators: async (_instance, ids) => people.filter(user => ids.includes(user.CODIGO)),
	sectorOperators: async () => people, walletName: async () => "Equipe"
};
const run = (steps: FlowStepDefinition[], input: Record<string, unknown> = {}, reads = base) =>
	simulateMessageFlow(tenant, sector, steps, { contactId: contact.id, ...input }, reads);
const assign: FlowStepDefinition = { type: "ASSIGN", stepNumber: 2, config: { userId: 11 } };
const admin: FlowStepDefinition = { type: "SEND_TO_ADMIN", stepNumber: 3 };
const available: FlowStepDefinition[] = [{ type: "CHECK_AVAILABLE_USERS", stepNumber: 1, nextStepId: 3 }, admin];
const sampleFlow: FlowStepDefinition[] = [
	{ type: "QUERY", stepNumber: 1, nextStepId: 4, fallbackStepId: 3,
		config: { query: "SQL privado do cliente", storeAs: "rows", single: true, required: true } },
	{ type: "CONDITION", stepNumber: 4, config: { field: "rows.ok", operator: "equals", value: false }, connections: { onTrue: 2, onFalse: 3 } },
	assign, admin
];
async function main() {
	const onlineFlow = (config: Record<string, unknown>): FlowStepDefinition[] => [
		{ type: "CHECK_USER_ONLINE", stepNumber: 1, config, connections: { onTrue: 2, onFalse: 3 } }, assign, admin
	];
	assert.equal((await run(onlineFlow({ userId: 11 }))).destination?.id, 11);
	assert.equal((await run(onlineFlow({ userId: 11 }), { scenario: { pausedUserIds: [11] } })).destination?.kind, "admin");
	assert.equal((await run(onlineFlow({ userId: 33 }))).destination?.kind, "admin");
	assert.equal((await run(onlineFlow({ userIdField: "contact.customerId", userId: 11 }))).destination?.kind, "admin");
	const previousField = onlineFlow({ userIdField: "rows.operatorId" });
	const query = { ...sampleFlow[0]!, stepNumber: 1, nextStepId: 4 };
	const legacyFlow = [query, { ...previousField[0]!, stepNumber: 4 }, assign, admin];
	assert.equal((await run(legacyFlow, { scenario: { querySamples: { 1: [{ operatorId: 11 }] } } })).destination?.id, 11);
	for (const userId of [0, -1, 1.5, "11", 2147483648]) {
		await assert.rejects(run(onlineFlow({ userId })), err => err instanceof FlowSimulationError && err.status === 422);
	}
	const botFlow = [{ type: "START_BOT", stepNumber: 1, fallbackStepId: 3, config: { botId: 9 } }, admin];
	const simulatedBot = await run(botFlow, { channelId: 9 });
	assert.deepEqual(simulatedBot.destination, { kind: "bot", id: 9, name: "Recepção", version: 3 });
	assert.deepEqual(simulatedBot.trace.map(entry => entry.stepNumber), [1]);
	for (const input of [{ channelId: 8 }, {}]) {
		const unavailable = await run(botFlow, input);
		assert.equal(unavailable.destination?.kind, "admin");
		assert.deepEqual(unavailable.trace.map(entry => entry.stepNumber), [1, 3]);
	}
	await assert.rejects(run(botFlow, { channelId: 0 }), err => err instanceof FlowSimulationError && err.status === 400);
	await assert.rejects(run([{ ...botFlow[0]!, fallbackStepId: null }, admin]), err => err instanceof FlowSimulationError && err.status === 422);
	const odim = buildOdimInboundFlow({ instance: tenant, sectorId: sector, clientId: 20, assigneeId: 11, fallbackUserId: 22 });
	const linked = await run(odim.steps);
	assert.deepEqual(linked.destination, { kind: "user", id: 33, name: "Nome 33" });
	assert.deepEqual(linked.trace.map(x => x.stepNumber), [1, 2, 3, 4]);
	assert.equal(resolutionLookups, 1);
	assert.equal(contact.customerId, null);
	assert.match((await run(odim.steps, { scenario: { isOnlyAdmin: true } })).reason, /administra/);
	assert.equal((await run(odim.steps, { scenario: { customerStatus: "ambiguous" } })).destination?.id, 11);
	assert.equal(resolutionLookups, 1);
	assert.equal((await run(odim.steps, { scenario: { customerId: 404, customerStatus: "found", loyaltyUserId: null } })).destination?.id, 22);
	assert.equal((await run(available)).destination?.id, 22);
	const tie = await run(available, { scenario: { onlineUserIds: [22, 11], pausedUserIds: [], openChats: { "22": 3, "11": 3 } } });
	assert.match(tie.reason, /empatada/);
	assert.equal(tie.destination?.id, 22);
	assert.equal((await run(available, { scenario: { pausedUserIds: [22] } })).destination?.id, 11);
	assert.equal((await run(available, { scenario: { onlineUserIds: [] } })).destination?.kind, "admin");
	const missing = await run(sampleFlow);
	assert.equal(missing.status, "indeterminate");
	assert.deepEqual(missing.trace.map(x => x.stepNumber), [1]);
	assert.doesNotMatch(JSON.stringify(missing), /SQL privado/);
	assert.equal((await run(sampleFlow, { scenario: { querySamples: { 1: [] } } })).destination?.kind, "admin");
	assert.equal((await run(sampleFlow, { scenario: { querySamples: { 1: [{ ok: false }] } } })).destination?.id, 11);
	assert.equal((await run(sampleFlow, { scenario: { querySamples: { 1: [{ ok: "false" }] } } })).destination?.kind, "admin");
	const byText: FlowStepDefinition[] = [
		{ type: "ROUTER", stepNumber: 1, config: { field: "message.body" }, connections: { routes: { oi: 2, novamente: 1 }, defaultRoute: 3 } }, assign, admin
	];
	assert.equal((await run(byText, { messageBody: "oi" })).destination?.id, 11);
	const cycle = await run(byText, { messageBody: "novamente" });
	assert.equal(cycle.status, "error");
	assert.equal(cycle.trace.length, 50);
	assert.match(cycle.reason, /50 etapas/);
	const wallet = await run([{ type: "ASSIGN", stepNumber: 1, config: { walletId: 9 } }]);
	assert.deepEqual(wallet.destination, { kind: "wallet", id: 9, name: "Equipe" });
	await assert.rejects(run(available, {}, { ...base, contact: async () => ({ ...contact, instance: "outside" }) }), err => err instanceof FlowSimulationError && err.status === 404);
	await assert.rejects(run(available, { scenario: { onlineUserIds: [0] } }), err => err instanceof FlowSimulationError && err.status === 400);
	await assert.rejects(run(available, { scenario: { customerStatus: "found" } }), err => err instanceof FlowSimulationError && err.status === 400);
	await assert.rejects(run([{ type: "AI_AGENT", stepNumber: 1, nextStepId: 2 }, assign]), err => err instanceof FlowSimulationError && err.status === 422);
	assert.equal(unexpected, 0);
	console.log("Simulação de fluxo: resolução em memória, cenários, SQL por amostra, destinos, traçado, escopo, validação e limite de ciclo verificados.");
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
