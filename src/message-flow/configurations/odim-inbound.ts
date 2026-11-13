import type { FlowStepDefinition } from "../flow-definition";
import { assertFlowDefinition } from "../flow-definition";

export interface InboundFlowTargets { instance: string; sectorId: number; clientId: number; assigneeId: number; fallbackUserId: number; }
export interface InboundFlowConfiguration extends InboundFlowTargets { description: string; steps: FlowStepDefinition[]; }

/** IDs belong to a reviewed environment-specific configuration, never the executor. */
export function buildOdimInboundFlow(targets: InboundFlowTargets): InboundFlowConfiguration {
	if (!targets.instance || ![targets.sectorId, targets.clientId, targets.assigneeId, targets.fallbackUserId].every((id) => Number.isSafeInteger(id) && id > 0) || targets.assigneeId === targets.fallbackUserId)
		throw new Error("Invalid inbound flow targets");
	const assign = (stepNumber: number, decisionReason: string, systemMessage: string): FlowStepDefinition => ({
		type: "ASSIGN", stepNumber, enabled: true,
		config: { userId: targets.assigneeId, validateUser: true, fallbackUserId: targets.fallbackUserId,
			fallbackRequireAdmin: true, decisionReason, systemMessage }
	});
	const configuration: InboundFlowConfiguration = { ...targets,
		description: "Odim: identificação CRM e triagem de contatos sem vínculo",
		steps: [
			{ type: "CHECK_ONLY_ADMIN", stepNumber: 1, nextStepId: 2, enabled: true },
			{ type: "QUERY", stepNumber: 2, nextStepId: 3, fallbackStepId: 12, enabled: true,
				config: { operation: "resolveContactCustomer", storeAs: "customerResolution" } },
			{ type: "ROUTER", stepNumber: 3, enabled: true, config: { field: "customerResolution.status" },
				connections: { routes: { found: 4, not_found: 10, ambiguous: 11, unavailable: 12 }, defaultRoute: 12 } },
			{ type: "CHECK_LOALTY", stepNumber: 4, nextStepId: 5, enabled: true },
			{ type: "CHECK_AVAILABLE_USERS", stepNumber: 5, nextStepId: 6, enabled: true },
			{ type: "SEND_TO_ADMIN", stepNumber: 6, enabled: true },
			assign(10, "customer_not_found", "Contato sem cadastro identificado. Encaminhado à responsável."),
			assign(11, "customer_lookup_ambiguous", "Cadastro pendente de verificação. Encaminhado à responsável."),
			assign(12, "customer_lookup_unavailable", "Cadastro pendente de verificação. Encaminhado à responsável.")
		]
	};
	assertFlowDefinition(configuration.steps);
	return configuration;
}

export interface FlowDeploymentPreflight {
	instance: string; sectorId: number; clientId: number; clientActive: boolean; clientSectorIds: number[];
	operators: Array<{ id: number; active: boolean; sectorId: number; role: string; accessibleToSupervision: boolean }>;
}

/** The caller obtains this evidence through approved read-only tools before any configuration write. */
export function assertInboundFlowPreflight(config: InboundFlowConfiguration, evidence: FlowDeploymentPreflight): void {
	if (config.instance !== evidence.instance || config.sectorId !== evidence.sectorId || config.clientId !== evidence.clientId ||
		!evidence.clientActive || !evidence.clientSectorIds.includes(config.sectorId)) throw new Error("Inbound channel/sector preflight failed");
	for (const id of [config.assigneeId, config.fallbackUserId]) {
		const matches = evidence.operators.filter((item) => item.id === id);
		if (matches.length !== 1 || !matches[0]!.active || matches[0]!.sectorId !== config.sectorId || !matches[0]!.accessibleToSupervision ||
			(id === config.fallbackUserId && matches[0]!.role !== "ADMIN")) throw new Error("Inbound assignment preflight failed");
	}
}
