import { Logger } from "@in.pulse-crm/utils";
import prismaService from "../services/prisma.service";
import { BaseStep } from "./base/base.step";
import MessageFlow from "./message-flow";
import { StepRegistry } from "./step-registry";

export default class MessageFlowFactory {
	/**
	 * Cria uma instância de step usando o StepRegistry.
	 */
	private static createStep(
		type: string,
		instance: string,
		sectorId: number,
		stepNumber: number,
		nextStepNumber?: number,
		config?: Record<string, any>,
		fallbackStepNumber?: number,
		connections?: Record<string, any>
	): BaseStep {
		const stepConfig: any = {
			stepNumber,
			instance,
			sectorId,
			config: config || {},
			connections: connections || {}
		};

		if (nextStepNumber !== undefined) {
			stepConfig.nextStepNumber = nextStepNumber;
		}
		if (fallbackStepNumber !== undefined) {
			stepConfig.fallbackStepNumber = fallbackStepNumber;
		}

		try {
			const step = StepRegistry.create(type, stepConfig);
			return step;
		} catch (error: any) {
			throw error;
		}
	}

	public static createDefaultMessageFlow(instance: string, sectorId: number): MessageFlow {
		const messageFlow = new MessageFlow();

		const steps = [
			{ type: "CHECK_ONLY_ADMIN", stepNumber: 1, nextStepNumber: 2 },
			{ type: "CHECK_LOALTY", stepNumber: 2, nextStepNumber: 3 },
			{ type: "CHECK_AVAILABLE_USERS", stepNumber: 3, nextStepNumber: 4 },
			{ type: "SEND_TO_ADMIN", stepNumber: 4 }
		];

		for (const stepConfig of steps) {
			const step = this.createStep(
				stepConfig.type,
				instance,
				sectorId,
				stepConfig.stepNumber,
				stepConfig.nextStepNumber
			);
			messageFlow.addStep(step);
		}
		messageFlow.debugStepsMap();
		return messageFlow;
	}

	public static async createMessageFlow(instance: string, sectorId: number): Promise<MessageFlow> {
		try {
			const flow = await prismaService.wppMessageFlow.findUnique({
				where: {
					instance_sectorId: {
						instance,
						sectorId
					}
				},
				include: {
					WppMessageFlowStep: true
				}
			});

			if (!flow) {
				return this.createDefaultMessageFlow(instance, sectorId);
			}

			const messageFlow = new MessageFlow();
			// Ordena os steps por stepNumber para garantir a ordem correta
			const sortedSteps = [...flow.WppMessageFlowStep].sort((a, b) => a.stepNumber - b.stepNumber);

			for (const step of sortedSteps) {
				// Usa os valores do banco de dados para next e fallback
				const stepConfig: any = {
					stepNumber: step.stepNumber,
					instance,
					sectorId,
					config: MessageFlowFactory.getValidatedStepConfig(step.config),
					connections: step.connections || {}
				};

				// Adiciona nextStepNumber se definido no banco
				if (step.nextStepId !== null && step.nextStepId !== undefined) {
					stepConfig.nextStepNumber = step.nextStepId;
				}

				// Adiciona fallbackStepNumber se definido no banco
				if (step.fallbackStepId !== null && step.fallbackStepId !== undefined) {
					stepConfig.fallbackStepNumber = step.fallbackStepId;
				}

				const stepInstance = this.createStep(
					step.type as string,
					instance,
					sectorId,
					step.stepNumber,
					stepConfig.nextStepNumber,
					stepConfig.config,
					stepConfig.fallbackStepNumber,
					stepConfig.connections
				);

				messageFlow.addStep(stepInstance);
			}
			messageFlow.debugStepsMap();
			return messageFlow;
		} catch (error: any) {
			throw error;
		}
	}

	private static getValidatedStepConfig(stepConfig: any): Record<string, any> {
		if (!stepConfig || typeof stepConfig !== "object") {
			return {};
		}
		return stepConfig;
	}
}
