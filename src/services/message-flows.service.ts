import { Logger } from "@in.pulse-crm/utils";
import { WppMessageFlowStepType } from "@prisma/client";
import prismaService from "./prisma.service";

interface CreateFlowDto {
	instance: string;
	sectorId: number;
	description?: string;
}

interface CreateStepDto {
	type: WppMessageFlowStepType;
	stepNumber: number;
	nextStepId?: number | null;
	fallbackStepId?: number | null;
	config?: Record<string, any> | null;
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
	connections?: Record<string, number> | null;
}

class MessageFlowsService {
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

		const flows = await prismaService.wppMessageFlow.findMany({
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
		const flow = await prismaService.wppMessageFlow.findUnique({
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
		const flow = await prismaService.wppMessageFlow.findUnique({
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
		Logger.info(`[MessageFlowsService] Creating flow for ${data.instance}/${data.sectorId}`);

		// Verifica se já existe
		const existing = await this.getFlowByInstanceAndSector(data.instance, data.sectorId);
		if (existing) {
			throw new Error(`Flow already exists for instance ${data.instance} and sector ${data.sectorId}`);
		}

		const flow = await prismaService.wppMessageFlow.create({
			data: {
				instance: data.instance,
				sectorId: data.sectorId,
				description: data.description || null
			},
			include: {
				WppMessageFlowStep: true
			}
		});

		Logger.info(`[MessageFlowsService] Flow created with ID ${flow.id}`);
		return flow;
	}

	/**
	 * Atualiza um fluxo
	 */
	async updateFlow(flowId: number, data: UpdateFlowDto) {
		Logger.info(`[MessageFlowsService] Updating flow ${flowId}`);

		const updateData: any = {};
		if (data.description !== undefined) {
			updateData.description = data.description || null;
		}

		const flow = await prismaService.wppMessageFlow.update({
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

		Logger.info(`[MessageFlowsService] Flow ${flowId} updated`);
		return flow;
	}

	/**
	 * Deleta um fluxo (e todos os steps)
	 */
	async deleteFlow(flowId: number) {
		Logger.info(`[MessageFlowsService] Deleting flow ${flowId}`);

		await prismaService.wppMessageFlow.delete({
			where: { id: flowId }
		});

		Logger.info(`[MessageFlowsService] Flow ${flowId} deleted`);
	}

	/**
	 * Adiciona um step ao fluxo
	 */
	async createStep(flowId: number, data: CreateStepDto) {
		Logger.info(`[MessageFlowsService] Creating step #${data.stepNumber} for flow ${flowId}`);

		// Verifica se o fluxo existe
		await this.getFlow(flowId);

		// Verifica se já existe step com esse número
		const existing = await prismaService.wppMessageFlowStep.findFirst({
			where: {
				messageFlowId: flowId,
				stepNumber: data.stepNumber
			}
		});

		if (existing) {
			throw new Error(`Step number ${data.stepNumber} already exists in flow ${flowId}`);
		}

		const step = await prismaService.wppMessageFlowStep.create({
			data: {
				messageFlowId: flowId,
				type: data.type,
				stepNumber: data.stepNumber,
				nextStepId: data.nextStepId !== undefined ? data.nextStepId : null,
				fallbackStepId: data.fallbackStepId !== undefined ? data.fallbackStepId : null,
				config: data.config !== undefined ? (data.config as any) : null,
				enabled: data.enabled ?? true,
				description: data.description || null
			}
		});

		Logger.info(`[MessageFlowsService] Step ${step.id} created`);
		return step;
	}

	/**
	 * Atualiza um step
	 */
	async updateStep(stepId: number, data: UpdateStepDto) {
		Logger.info(`[MessageFlowsService] Updating step ${stepId}`);

		const updateData: any = {};
		if (data.type !== undefined) updateData.type = data.type;
		if (data.stepNumber !== undefined) updateData.stepNumber = data.stepNumber;
		if (data.nextStepId !== undefined) updateData.nextStepId = data.nextStepId;
		if (data.fallbackStepId !== undefined) updateData.fallbackStepId = data.fallbackStepId;
		if (data.config !== undefined) updateData.config = data.config as any;
		if (data.enabled !== undefined) updateData.enabled = data.enabled;
		if (data.description !== undefined) updateData.description = data.description;
		if (data.connections !== undefined) updateData.connections = data.connections as any;

		Logger.debug(`[MessageFlowsService] Update data for step ${stepId}:`, updateData);

		const step = await prismaService.wppMessageFlowStep.update({
			where: { id: stepId },
			data: updateData
		});

		Logger.info(`[MessageFlowsService] Step ${stepId} updated`);
		return step;
	}

	/**
	 * Deleta um step
	 */
	async deleteStep(stepId: number) {
		Logger.info(`[MessageFlowsService] Deleting step ${stepId}`);

		await prismaService.wppMessageFlowStep.delete({
			where: { id: stepId }
		});

		Logger.info(`[MessageFlowsService] Step ${stepId} deleted`);
	}

	/**
	 * Reordena steps de um fluxo
	 */
	async reorderSteps(flowId: number, stepOrders: Array<{ stepId: number; stepNumber: number }>) {
		Logger.info(`[MessageFlowsService] Reordering steps for flow ${flowId}`);

		// Atualiza cada step em uma transação
		await prismaService.$transaction(
			stepOrders.map(({ stepId, stepNumber }) =>
				prismaService.wppMessageFlowStep.update({
					where: { id: stepId },
					data: { stepNumber }
				})
			)
		);

		Logger.info(`[MessageFlowsService] Steps reordered`);
	}

	/**
	 * Valida a integridade de um fluxo
	 */
	async validateFlow(flowId: number): Promise<{ valid: boolean; errors: string[] }> {
		const flow = await this.getFlow(flowId);
		const errors: string[] = [];

		// Verifica se existe step #1
		const hasStepOne = flow.WppMessageFlowStep.some((s) => s.stepNumber === 1);
		if (!hasStepOne) {
			errors.push("Flow must have a step with stepNumber = 1");
		}

		// Verifica next_step_id
		for (const step of flow.WppMessageFlowStep) {
			if (step.nextStepId !== null) {
				const nextStepExists = flow.WppMessageFlowStep.some((s) => s.stepNumber === step.nextStepId);
				if (!nextStepExists) {
					errors.push(`Step #${step.stepNumber} references non-existent next step #${step.nextStepId}`);
				}
			}
		}

		// Verifica fallback_step_id
		for (const step of flow.WppMessageFlowStep) {
			if (step.fallbackStepId !== null) {
				const fallbackStepExists = flow.WppMessageFlowStep.some((s) => s.stepNumber === step.fallbackStepId);
				if (!fallbackStepExists) {
					errors.push(
						`Step #${step.stepNumber} references non-existent fallback step #${step.fallbackStepId}`
					);
				}
			}
		}

		// Verifica steps finais (devem ter nextStepId = null)
		const stepsWithoutNext = flow.WppMessageFlowStep.filter((s) => s.nextStepId === null);
		if (stepsWithoutNext.length === 0) {
			errors.push("Flow must have at least one final step (nextStepId = null)");
		}

		// Verifica loops infinitos simples
		for (const step of flow.WppMessageFlowStep) {
			if (step.nextStepId === step.stepNumber) {
				errors.push(`Step #${step.stepNumber} references itself (infinite loop)`);
			}
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
		Logger.info(`[MessageFlowsService] Duplicating flow ${flowId} to ${targetInstance}/${targetSectorId}`);

		const sourceFlow = await this.getFlow(flowId);

		// Cria o novo fluxo
		const newFlow = await this.createFlow({
			instance: targetInstance,
			sectorId: targetSectorId,
			description: `${sourceFlow.description || ""} (cópia)`
		});

		// Copia todos os steps
		for (const step of sourceFlow.WppMessageFlowStep) {
			await this.createStep(newFlow.id, {
				type: step.type,
				stepNumber: step.stepNumber,
				nextStepId: step.nextStepId,
				fallbackStepId: step.fallbackStepId,
				config: step.config as any,
				enabled: step.enabled,
				description: step.description || ""
			});
		}

		Logger.info(`[MessageFlowsService] Flow duplicated to ID ${newFlow.id}`);
		return newFlow.id;
	}
}

export default new MessageFlowsService();
