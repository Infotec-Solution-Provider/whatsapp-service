import { createHash } from "node:crypto";
import { assertFlowDefinition } from "../message-flow/flow-definition";
import { assertInboundFlowPreflight, buildOdimInboundFlow, type InboundFlowConfiguration, type FlowDeploymentPreflight } from "../message-flow/configurations/odim-inbound";
import { messageFlowCache } from "../message-flow/message-flow-cache";

function definition(flow: any) {
	return { instance: flow.instance, sectorId: flow.sectorId, description: flow.description,
		steps: flow.WppMessageFlowStep.map((step: any) => ({ type: step.type, stepNumber: step.stepNumber,
			nextStepId: step.nextStepId ?? null, fallbackStepId: step.fallbackStepId ?? null,
			config: step.config ?? null, connections: step.connections ?? null, enabled: step.enabled ?? true,
			description: step.description ?? null })).sort((a: any, b: any) => a.stepNumber - b.stepNumber) };
}
function canonical(value: any): any {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	return value;
}
export const inboundFlowFingerprint = (flow: unknown): string => createHash("sha256").update(JSON.stringify(canonical(definition(flow)))).digest("hex");
export interface InstalledFlowReceipt { instance: string; sectorId: number; flowId: number; fingerprint: string; previous: null; }

export function assertPreparedInboundConfiguration(config: InboundFlowConfiguration): void {
	const expected = buildOdimInboundFlow(config);
	if (JSON.stringify(canonical(config.steps)) !== JSON.stringify(canonical(expected.steps))) throw Error("FLOW_STEPS_DIFFER_FROM_REVIEWED_TARGETS");
}

export async function assertInboundFlowCentralScope(db: any, config: InboundFlowConfiguration): Promise<void> {
	const sector = await db.wppSector.findFirst({ where: { id: config.sectorId, instance: config.instance }, select: { id: true } });
	const client = await db.wppClient.findFirst({ where: { id: config.clientId, instance: config.instance, isActive: true }, select: { id: true, sectors: { select: { id: true } } } });
	if (!sector || !client?.sectors.some((item: { id: number }) => item.id === config.sectorId)) throw Error("FLOW_CHANNEL_SCOPE_CHANGED");
}

/** New-flow installation is atomic and refuses every existing definition, including concurrent creation. */
export async function installAbsentInboundFlow(db: any, config: InboundFlowConfiguration, evidence: FlowDeploymentPreflight,
	beforeCommit?: (receipt: InstalledFlowReceipt) => Promise<void>): Promise<InstalledFlowReceipt> {
	assertInboundFlowPreflight(config, evidence);
	assertPreparedInboundConfiguration(config);
	assertFlowDefinition(config.steps);
	const flow = await db.$transaction(async (tx: any) => {
		await assertInboundFlowCentralScope(tx, config);
		const existing = await tx.wppMessageFlow.findUnique({ where: { instance_sectorId: { instance: config.instance, sectorId: config.sectorId } } });
		if (existing) throw Error("FLOW_ALREADY_EXISTS");
		const installed = await tx.wppMessageFlow.create({ data: { instance: config.instance, sectorId: config.sectorId, description: config.description,
			WppMessageFlowStep: { create: config.steps.map(step => ({ type: step.type, stepNumber: step.stepNumber,
				nextStepId: step.nextStepId ?? null, fallbackStepId: step.fallbackStepId ?? null,
				config: step.config ?? undefined, connections: step.connections ?? undefined,
				enabled: step.enabled ?? true, description: null })) } }, include: { WppMessageFlowStep: true } });
		await beforeCommit?.({ instance: config.instance, sectorId: config.sectorId, flowId: installed.id, fingerprint: inboundFlowFingerprint(installed), previous: null });
		return installed;
	});
	messageFlowCache.invalidate(config.instance, config.sectorId);
	return { instance: config.instance, sectorId: config.sectorId, flowId: flow.id, fingerprint: inboundFlowFingerprint(flow), previous: null };
}

/** Rollback refuses to remove a flow subsequently edited by an operator. It never touches chats/messages. */
export async function removeUnchangedInstalledFlow(db: any, receipt: InstalledFlowReceipt): Promise<void> {
	if (!Number.isSafeInteger(receipt.flowId) || receipt.flowId <= 0 || !receipt.instance || !Number.isSafeInteger(receipt.sectorId) || receipt.sectorId <= 0 || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || receipt.previous !== null) throw Error("INVALID_FLOW_RECEIPT");
	await db.$transaction(async (tx: any) => {
		await tx.$queryRawUnsafe("SELECT id FROM message_flows WHERE id=? AND instance=? AND sector_id=? FOR UPDATE", receipt.flowId, receipt.instance, receipt.sectorId);
		await tx.$queryRawUnsafe("SELECT id FROM message_flows_steps WHERE message_flow_id=? FOR UPDATE", receipt.flowId);
		const flow = await tx.wppMessageFlow.findUnique({ where: { id: receipt.flowId }, include: { WppMessageFlowStep: true } });
		if (!flow || flow.instance !== receipt.instance || flow.sectorId !== receipt.sectorId || inboundFlowFingerprint(flow) !== receipt.fingerprint) throw Error("FLOW_CHANGED_SINCE_INSTALL");
		await tx.wppMessageFlowStep.deleteMany({ where: { messageFlowId: receipt.flowId } });
		await tx.wppMessageFlow.delete({ where: { id: receipt.flowId } });
	});
	messageFlowCache.invalidate(receipt.instance, receipt.sectorId);
}
