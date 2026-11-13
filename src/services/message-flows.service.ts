import { WppMessageFlowStepType } from "@prisma/client";
import prismaService from "./prisma.service";
import { messageFlowCache } from "../message-flow/message-flow-cache";
import { validateFlowDefinition } from "../message-flow/flow-definition";
import { StepRegistry } from "../message-flow/step-registry";

interface CreateFlowDto {
	instance: string;
	sectorId: number;
	description?: string;
}

export interface CreateStepDto {
	type: WppMessageFlowStepType;
	stepNumber: number;
	nextStepId?: number | null;
	fallbackStepId?: number | null;
	config?: Record<string, any> | null;
	connections?: Record<string, any> | null;
	enabled?: boolean;
	description?: string;
}

interface UpdateFlowDto {
	description?: string;
}

interface UpdateStepDto {
	type?: WppMessageFlowStepType;
	stepNumber?: number;
	nextStepId?: number | null;
	fallbackStepId?: number | null;
	config?: Record<string, any> | null;
	enabled?: boolean;
	description?: string;
	connections?: Record<string, any> | null;
}

export class MessageFlowsService {
	constructor(private readonly db: typeof prismaService = prismaService,
		private readonly invalidate: (instance: string, sectorId: number) => void = (instance, sectorId) => messageFlowCache.invalidate(instance, sectorId)) {}

	private validateStep(data: { type: string; stepNumber: number; config?: unknown; connections?: unknown }): void {
		if (!Number.isSafeInteger(data.stepNumber) || data.stepNumber <= 0) throw new Error("Step number must be a positive integer");
		if (!data.config || typeof data.config !== "object" || Array.isArray(data.config)) {
			if (data.config != null) throw new Error("Step config must be an object");
		}
		if (data.connections != null && (typeof data.connections !== "object" || Array.isArray(data.connections))) throw new Error("Step connections must be an object");
		StepRegistry.create(data.type, { instance: "validation", sectorId: 1, stepNumber: data.stepNumber, config: (data.config ?? {}) as Record<string, any> });
	}

	/**
	 * Lista todos os fluxos
	 */
	async listFlows(instance?: string, sectorId?: number) {
		const where: any = {};

		if (instance) {
			where.instance = instance;
		}

		if (sectorId !== undefined) {
			where.sectorId = sectorId;
		}

		const flows = await this.db.wppMessageFlow.findMany({
			where,
			include: {
				WppMessageFlowStep: {
					orderBy: {
						stepNumber: "asc"
					}
				}
			},
			orderBy: [{ instance: "asc" }, { sectorId: "asc" }]
		});

		return flows;
	}

	/**
	 * Busca um fluxo específico
	 */
	async getFlow(flowId: number) {
		const flow = await this.db.wppMessageFlow.findUnique({
			where: { id: flowId },
			include: {
				WppMessageFlowStep: {
					orderBy: {
						stepNumber: "asc"
					}
				}
			}
		});

		if (!flow) {
			throw new Error(`Flow ${flowId} not found`);
		}

		return flow;
	}

	/**
	 * Busca fluxo por instância e setor
	 */
	async getFlowByInstanceAndSector(instance: string, sectorId: number) {
		const flow = await this.db.wppMessageFlow.findUnique({
			where: {
				instance_sectorId: {
					instance,
					sectorId
				}
			},
			include: {
				WppMessageFlowStep: {
					orderBy: {
						stepNumber: "asc"
					}
				}
			}
		});

		return flow;
	}

	/**
	 * Cria um novo fluxo
	 */
	async createFlow(data: CreateFlowDto) {
		// Verifica se já existe
		const existing = await this.getFlowByInstanceAndSector(data.instance, data.sectorId);
		if (existing) {
			throw new Error(`Flow already exists for instance ${data.instance} and sector ${data.sectorId}`);
		}

		const flow = await this.db.wppMessageFlow.create({
			data: {
				instance: data.instance,
				sectorId: data.sectorId,
				description: data.description || null
			},
			include: {
				WppMessageFlowStep: true
			}
		});

		this.invalidate(flow.instance, flow.sectorId);
		return flow;
	}

	/**
	 * Atualiza um fluxo
	 */
	async updateFlow(flowId: number, data: UpdateFlowDto) {
		const updateData: any = {};
		if (data.description !== undefined) {
			updateData.description = data.description || null;
		}

		const flow = await this.db.wppMessageFlow.update({
			where: { id: flowId },
			data: updateData,
			include: {
				WppMessageFlowStep: {
					orderBy: {
						stepNumber: "asc"
					}
				}
			}
		});

		this.invalidate(flow.instance, flow.sectorId);
		return flow;
	}

	/**
	 * Deleta um fluxo (e todos os steps)
	 */
	async deleteFlow(flowId: number) {
		const flow = await this.db.wppMessageFlow.delete({ where: { id: flowId } });
		this.invalidate(flow.instance, flow.sectorId);
	}

	/**
	 * Adiciona um step ao fluxo
	 */
	async createStep(flowId: number, data: CreateStepDto) {
		// Verifica se o fluxo existe
		const flow = await this.getFlow(flowId);
		this.validateStep(data);

		// Verifica se já existe step com esse número
		const existing = await this.db.wppMessageFlowStep.findFirst({
			where: {
				messageFlowId: flowId,
				stepNumber: data.stepNumber
			}
		});

		if (existing) {
			throw new Error(`Step number ${data.stepNumber} already exists in flow ${flowId}`);
		}

		const step = await this.db.wppMessageFlowStep.create({
			data: {
				messageFlowId: flowId,
				type: data.type,
				stepNumber: data.stepNumber,
				nextStepId: data.nextStepId !== undefined ? data.nextStepId : null,
				fallbackStepId: data.fallbackStepId !== undefined ? data.fallbackStepId : null,
				config: data.config !== undefined ? (data.config as any) : null,
				connections: data.connections !== undefined ? (data.connections as any) : null,
				enabled: data.enabled ?? true,
				description: data.description || null
			}
		});

		this.invalidate(flow.instance, flow.sectorId);
		return step;
	}

	/**
	 * Atualiza um step
	 */
	async updateStep(stepId: number, data: UpdateStepDto) {
		const existing = await this.db.wppMessageFlowStep.findUniqueOrThrow({ where: { id: stepId } });
		const flow = await this.getFlow(existing.messageFlowId);
		this.validateStep({ ...existing, ...data });
		const updateData: any = {};
		if (data.type !== undefined) updateData.type = data.type;
		if (data.stepNumber !== undefined) updateData.stepNumber = data.stepNumber;
		if (data.nextStepId !== undefined) updateData.nextStepId = data.nextStepId;
		if (data.fallbackStepId !== undefined) updateData.fallbackStepId = data.fallbackStepId;
		if (data.config !== undefined) updateData.config = data.config as any;
		if (data.enabled !== undefined) updateData.enabled = data.enabled;
		if (data.description !== undefined) updateData.description = data.description;
		if (data.connections !== undefined) updateData.connections = data.connections as any;

		const step = await this.db.wppMessageFlowStep.update({
			where: { id: stepId },
			data: updateData
		});

		this.invalidate(flow.instance, flow.sectorId);
		return step;
	}

	/**
	 * Deleta um step
	 */
	async deleteStep(stepId: number) {
		const existing = await this.db.wppMessageFlowStep.findUniqueOrThrow({ where: { id: stepId } });
		const flow = await this.getFlow(existing.messageFlowId);
		await this.db.wppMessageFlowStep.delete({ where: { id: stepId } });
		this.invalidate(flow.instance, flow.sectorId);
	}

	/**
	 * Reordena steps de um fluxo
	 */
	async reorderSteps(flowId: number, stepOrders: Array<{ stepId: number; stepNumber: number }>) {
		const flow = await this.getFlow(flowId);
		const steps = flow.WppMessageFlowStep;
		const byId = new Map(steps.map((step) => [step.id, step]));
		if (new Set(stepOrders.map((item) => item.stepId)).size !== stepOrders.length ||
			stepOrders.some((item) => !byId.has(item.stepId) || !Number.isSafeInteger(item.stepNumber) || item.stepNumber <= 0))
			throw new Error("Reorder contains duplicate, foreign or invalid steps");
		const newNumbers = new Map(steps.map((step) => [step.stepNumber,
			stepOrders.find((item) => item.stepId === step.id)?.stepNumber ?? step.stepNumber]));
		if (new Set(newNumbers.values()).size !== steps.length) throw new Error("Reorder creates duplicate step numbers");
		const remap = (value: number | null) => value === null ? null : newNumbers.get(value) ?? value;
		const remapConnections = (value: unknown): Record<string, any> => {
			const result = { ...(value as Record<string, any> ?? {}) };
			for (const key of ["onTrue", "onFalse", "defaultRoute"]) if (typeof result[key] === "number") result[key] = remap(result[key]);
			if (result["routes"] && typeof result["routes"] === "object") result["routes"] = Object.fromEntries(Object.entries(result["routes"]).map(([key, target]) => [key, typeof target === "number" ? remap(target) : target]));
			return result;
		};
		const revised = steps.map((step) => ({ ...step, stepNumber: newNumbers.get(step.stepNumber)!,
			nextStepId: remap(step.nextStepId), fallbackStepId: remap(step.fallbackStepId), connections: remapConnections(step.connections) }));
		const errors = validateFlowDefinition(revised);
		if (errors.length) throw new Error(errors.join("; "));
		await this.db.$transaction(async (tx) => {
			// Temporary negative numbers allow swaps under the unique(flow,step_number) key.
			for (const step of steps) await tx.wppMessageFlowStep.update({ where: { id: step.id }, data: { stepNumber: -step.id } });
			for (const step of revised) await tx.wppMessageFlowStep.update({ where: { id: step.id }, data: {
				stepNumber: step.stepNumber, nextStepId: step.nextStepId, fallbackStepId: step.fallbackStepId, connections: step.connections as any
			} });
		});
		this.invalidate(flow.instance, flow.sectorId);
	}

	/**
	 * Valida a integridade de um fluxo
	 */
	async validateFlow(flowId: number): Promise<{ valid: boolean; errors: string[] }> {
		const flow = await this.getFlow(flowId);
		const errors = validateFlowDefinition(flow.WppMessageFlowStep);
		for (const step of flow.WppMessageFlowStep.filter((item) => item.enabled)) {
			try { this.validateStep(step); } catch (error) { errors.push(`Step #${step.stepNumber}: ${error instanceof Error ? error.message : "Invalid configuration"}`); }
		}

		return {
			valid: errors.length === 0,
			errors
		};
	}

	/**
	 * Lista tipos de steps disponíveis
	 */
	async getAvailableStepTypes() {
		return Object.values(WppMessageFlowStepType);
	}

	/**
	 * Duplica um fluxo para outra instância/setor
	 */
	async duplicateFlow(flowId: number, targetInstance: string, targetSectorId: number) {
		const sourceFlow = await this.getFlow(flowId);
		const flow = await this.db.wppMessageFlow.create({ data: {
			instance: targetInstance, sectorId: targetSectorId, description: `${sourceFlow.description || ""} (cópia)`,
			WppMessageFlowStep: { create: sourceFlow.WppMessageFlowStep.map((step) => ({
				type: step.type, stepNumber: step.stepNumber, nextStepId: step.nextStepId, fallbackStepId: step.fallbackStepId,
				config: step.config as any, connections: step.connections as any, enabled: step.enabled, description: step.description
			})) }
		} });
		this.invalidate(flow.instance, flow.sectorId);
		return flow.id;
	}

}

export default new MessageFlowsService();
