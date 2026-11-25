import assert from "node:assert/strict";
import { validateFlowDefinition } from "./flow-definition";
import { buildOdimInboundFlow, assertInboundFlowPreflight, FlowDeploymentPreflight } from "./configurations/odim-inbound";

const config = buildOdimInboundFlow({ instance: "fixture", clientId: 101, sectorId: 102, assigneeId: 103, fallbackUserId: 104 });
assert.deepEqual(validateFlowDefinition(config.steps), []);
assert.ok(validateFlowDefinition([{ type: "QUERY", stepNumber: 1, nextStepId: 1 }, { type: "ASSIGN", stepNumber: 99 }]).includes("Flow must contain a reachable assignment step"));
assert.ok(validateFlowDefinition([{ type: "CONDITION", stepNumber: 1, connections: { onTrue: 2, onFalse: "2" } }, { type: "ASSIGN", stepNumber: 2 }]).length);
assert.ok(validateFlowDefinition([{ type: "QUERY", stepNumber: 1, nextStepId: 2 }, { type: "ASSIGN", stepNumber: 2, enabled: false }]).length);
assert.ok(validateFlowDefinition([{ type: "QUERY", stepNumber: 1, nextStepId: 2, fallbackStepId: 3 }, { type: "ASSIGN", stepNumber: 2 }]).length);
assert.deepEqual(validateFlowDefinition([{ type: "CONDITION", stepNumber: 1, connections: { onTrue: 1, onFalse: 2 } }, { type: "ASSIGN", stepNumber: 2 }]), [], "conditional cycles with an exit retain existing semantics");
assert.ok(validateFlowDefinition([{ type: "ASSIGN", stepNumber: 0 }]).length);
assert.ok(validateFlowDefinition([{type:"START_BOT",stepNumber:1,config:{botId:5},fallbackStepId:2},
	{type:"CHECK_ONLY_ADMIN",stepNumber:2,nextStepId:1}]).length);
const preflight: FlowDeploymentPreflight = { instance: "fixture", clientId: 101, sectorId: 102, clientActive: true, clientSectorIds: [102],
	operators: [{ id: 103, active: true, sectorId: 102, role: "AMBOS", accessibleToSupervision: true }, { id: 104, active: true, sectorId: 102, role: "ADMIN", accessibleToSupervision: true }] };
assert.doesNotThrow(() => assertInboundFlowPreflight(config, preflight));
for (const evidence of [
	{ ...preflight, clientActive: false }, { ...preflight, clientSectorIds: [999] },
	{ ...preflight, operators: preflight.operators.map((item) => ({ ...item, active: false })) },
	{ ...preflight, operators: preflight.operators.map((item) => ({ ...item, accessibleToSupervision: false })) },
	{ ...preflight, operators: preflight.operators.map((item) => ({ ...item, role: "ATIVO" })) }
]) assert.throws(() => assertInboundFlowPreflight(config, evidence));
console.log("Flow definition and deployment preflight tests passed");
