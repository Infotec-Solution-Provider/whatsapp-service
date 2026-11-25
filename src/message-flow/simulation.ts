import type { WppContact, WppMessage } from "@prisma/client";
import MessageFlow from "./message-flow";
import type { BaseStep, ChatPayload, StepConfig } from "./base/base.step";
import { AssignStep } from "./base/assign.step";
import { ConditionStep } from "./base/condition.step";
import { QueryStep } from "./base/query.step";
import { RouterStep } from "./base/router.step";
import AvailableStep from "./steps/check-available-users.step";
import LoyaltyStep from "./steps/check-loalty.step";
import OnlyAdminStep from "./steps/check-only-admin.step";
import OnlineStep from "./steps/check-user-online.step";
import AdminStep from "./steps/send-to-admin.step";
import SectorUserStep from "./steps/send-to-sector-user.step";
import StartBotStep from "./steps/start-bot.step";
import { FlowStepDefinition, validateFlowDefinition } from "./flow-definition";
import { scenarioReads, SimulationReads, simulationReads } from "./simulation-reads";
import { FlowSimulationError, FlowScenario, isId, isRecord, validateSimulationInput } from "./simulation-scenario";
import { StepRegistry } from "./step-registry";

export { FlowSimulationError };
export type { SimulationInput, FlowScenario } from "./simulation-scenario";
type Destination = { kind: "user" | "wallet" | "admin"; id: number | null; name: string }
	| { kind: "bot"; id: number; name: string; version: number };
interface TraceEntry { stepNumber: number; type: string; nextStepNumber: number | null; reason: string }
export interface SimulationResult {
	status: "assigned" | "indeterminate" | "error";
	destination: Destination | null;
	trace: TraceEntry[];
	reason: string;
	observedAt: string;
}

function newInboundMessage(contact: WppContact, body: string, time: Date): WppMessage {
	return {
		id: 0, instance: contact.instance, contactId: contact.id, from: contact.whatsappId ?? contact.phone ?? "", to: "",
		body, type: "chat", chatId: null, clientId: null, isForwarded: false, isEdited: false, agentId: null,
		timestamp: String(Math.floor(time.getTime() / 1000)), sentAt: time, status: "RECEIVED", statusTimestamp: null,
		wwebjsId: null, wwebjsIdStanza: null, wabaId: null, gupshupId: null, gupshupRequestId: null, userId: null,
		quotedId: null, mentionMetadata: null, fileId: null, fileName: null, fileType: null, fileSize: null, billingCategory: null
	};
}

function createSimulationStep(def: FlowStepDefinition, cfg: StepConfig, reads: SimulationReads, scenario: FlowScenario): BaseStep {
	switch (def.type) {
		case "CONDITION": return new ConditionStep(cfg);
		case "ROUTER": return new RouterStep(cfg);
		case "CHECK_ONLY_ADMIN": return new OnlyAdminStep(cfg);
		case "SEND_TO_ADMIN": return new AdminStep(cfg);
		case "CHECK_LOALTY": return new LoyaltyStep(cfg, reads);
		case "CHECK_USER_ONLINE": return new OnlineStep(cfg, reads);
		case "CHECK_AVAILABLE_USERS": return new AvailableStep(cfg, reads);
		case "SEND_TO_SECTOR_USER": return new SectorUserStep(cfg, reads);
		case "ASSIGN": return new AssignStep(cfg, reads);
		case "START_BOT": return new StartBotStep(cfg);
		case "QUERY": {
			const storeAs = cfg.config?.["storeAs"];
			if (typeof storeAs !== "string" || ["__proto__", "prototype", "constructor", "contact", "message", "logger"].includes(storeAs)) {
				throw new FlowSimulationError(422, "INVALID_FLOW", `Variável de saída inválida na etapa ${def.stepNumber}.`);
			}
			// This adapter never receives a database connection. Missing samples are intercepted before step.run so a fallback cannot hide them.
			return new QueryStep(cfg, (scope, contact) => reads.resolveCustomer(contact, scope.sectorId),
				async () => scenario.querySamples![String(def.stepNumber)]!);
		}
		default: throw new FlowSimulationError(422, "UNSUPPORTED_STEP", `A etapa ${def.stepNumber} não pode ser simulada.`);
	}
}

async function destination(instance: string, payload: ChatPayload, reads: SimulationReads): Promise<Destination | null> {
	if (payload.startedBot) return { kind: "bot", ...payload.startedBot };
	if (payload.userId === -1 && !isId(payload.walletId)) return { kind: "admin", id: -1, name: "Administração do setor" };
	if (isId(payload.userId)) {
		const id = payload.userId;
		const rows = await reads.operators(instance, [id]).catch(() => []);
		return { kind: "user", id, name: rows.find(row => row.CODIGO === id)?.NOME || `Operador #${id}` };
	}
	if (isId(payload.walletId)) {
		const id = payload.walletId;
		const name = await reads.walletName(instance, id).catch(() => null);
		return { kind: "wallet", id, name: name || `Carteira #${id}` };
	}
	return null;
}

class SampleNeeded extends Error {}

function requiresSample(step: FlowStepDefinition): boolean {
	return step.type === "QUERY" && !(isRecord(step.config) && step.config["operation"]);
}

export async function simulateMessageFlow(instance: string, sectorId: number, steps: readonly FlowStepDefinition[], input: unknown,
	base: SimulationReads = simulationReads): Promise<SimulationResult> {
	validateSimulationInput(input);
	if (!isId(sectorId) || !Array.isArray(steps) || steps.length > 500 || steps.some(step => !isRecord(step)) || validateFlowDefinition(steps).length) {
		throw new FlowSimulationError(422, "INVALID_FLOW", "Corrija os erros de validação do fluxo antes de simular.");
	}
	const scenario = input.scenario ?? {};
	const reads = scenarioReads(instance, sectorId, scenario, base);
	const byNumber = new Map<number, FlowStepDefinition>(steps.filter(step => step.enabled !== false).map(step => [step.stepNumber, step]));
	const trace: TraceEntry[] = [];
	const clock = new Date();
	const observedAt = clock.toISOString();
	const flow = new MessageFlow({
		beforeStep(number) {
			const step = byNumber.get(number)!;
			trace.push({ stepNumber: number, type: step.type, reason: "", nextStepNumber: null });
			if (requiresSample(step) && !Object.hasOwn(scenario.querySamples ?? {}, number)) {
				throw new SampleNeeded(`Informe as linhas de exemplo para a consulta da etapa ${number}.`);
			}
		},
		afterStep(_number, result) {
			const entry = trace[trace.length - 1]!;
			entry.nextStepNumber = result.nextStepNumber ?? null;
			entry.reason = result.reason ?? "Etapa concluída.";
			if (requiresSample(byNumber.get(entry.stepNumber)!)) entry.reason += " Usou as linhas de exemplo do cenário.";
		}
	});
	for (const step of byNumber.values()) {
		const config: StepConfig = { instance, sectorId, stepNumber: step.stepNumber,
			...(isRecord(step.config) && { config: step.config }), ...(isRecord(step.connections) && { connections: step.connections }),
			...(isId(step.nextStepId) && { nextStepNumber: step.nextStepId }), ...(isId(step.fallbackStepId) && { fallbackStepNumber: step.fallbackStepId })
		};
		try { StepRegistry.create(step.type, config); } catch {
			throw new FlowSimulationError(422, "INVALID_FLOW", `Configuração inválida na etapa ${step.stepNumber}.`);
		}
		flow.addStep(createSimulationStep(step, config, reads, scenario));
	}
	const record = await base.contact(instance, input.contactId).catch(() => { throw new FlowSimulationError(503, "CONTACT_LOOKUP_UNAVAILABLE", "Não foi possível consultar o contato."); });
	if (!record || record.instance !== instance || record.isDeleted || record.id !== input.contactId) throw new FlowSimulationError(404, "CONTACT_NOT_FOUND", "Contato indisponível nesta empresa.");
	const contact = { ...record };
	if (scenario.isOnlyAdmin !== undefined) contact.isOnlyAdmin = scenario.isOnlyAdmin;
	if (scenario.customerId !== undefined) contact.customerId = scenario.customerId;
	if (scenario.customerStatus === "found" && !isId(contact.customerId)) throw new FlowSimulationError(400, "MISSING_CUSTOMER", "Informe o cliente para simular o vínculo.");
	if (scenario.customerStatus && scenario.customerStatus !== "found") contact.customerId = null;
	try {
		const message = newInboundMessage(contact, input.messageBody ?? "", clock);
		message.clientId = input.channelId ?? null;
		const payload = await flow.getChatPayload({ log() {}, failed() {} }, contact, message, {
			startBot: async (botId) => {
				if (!input.channelId) return null;
				return reads.previewBot(instance, sectorId, input.channelId, botId);
			}
		});
		const target = await destination(instance, payload, reads);
		if (!target) return { status: "error", destination: null, reason: "O fluxo retornou um destino inválido.", observedAt, trace };
		return { status: "assigned", destination: target, reason: trace.at(-1)?.reason || "Destino previsto pelo fluxo.", observedAt, trace };
	} catch (error) {
		const sample = error instanceof SampleNeeded;
		const reason = sample ? error.message : trace.length === 50 ? "O fluxo atingiu o limite de 50 etapas." : "A etapa não conseguiu determinar um destino com os dados disponíveis.";
		const last = trace.at(-1);
		if (last && !last.reason) last.reason = reason;
		return { status: sample ? "indeterminate" : "error", destination: null, reason, observedAt, trace };
	}
}
