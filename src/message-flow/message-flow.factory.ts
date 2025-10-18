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
		fallbackStepNumber?: number
	): BaseStep {
		Logger.debug(`[MessageFlowFactory] Creating step`, {
			type,
			instance,
			sectorId,
			stepNumber,
			nextStepNumber,
			fallbackStepNumber,
			config
		});

		const stepConfig: any = {
			stepNumber,
			instance,
			sectorId,
			config: config || {}
		};

		if (nextStepNumber !== undefined) {
			stepConfig.nextStepNumber = nextStepNumber;
		}

		if (fallbackStepNumber !== undefined) {
			stepConfig.fallbackStepNumber = fallbackStepNumber;
		}

		try {
			const step = StepRegistry.create(type, stepConfig);
			Logger.debug(`[MessageFlowFactory] Step created successfully`, { type, stepNumber });
			return step;
		} catch (error: any) {
			Logger.error(`[MessageFlowFactory] Failed to create step: type=${type}, stepNumber=${stepNumber}`, error);
			throw error;
		}
	}

	public static createDefaultMessageFlow(instance: string, sectorId: number): MessageFlow {
		Logger.debug(`[MessageFlowFactory] Creating default message flow`, { instance, sectorId });

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

		Logger.debug(`[MessageFlowFactory] Default message flow created with ${steps.length} steps`);
		messageFlow.debugStepsMap();
		return messageFlow;
	}

	public static async createMessageFlow(instance: string, sectorId: number): Promise<MessageFlow> {
		Logger.debug(`[MessageFlowFactory] Loading message flow from database`, { instance, sectorId });

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
				Logger.debug(`[MessageFlowFactory] No custom flow found, using default flow`);
				return this.createDefaultMessageFlow(instance, sectorId);
			}

			Logger.debug(`[MessageFlowFactory] Custom flow found with ${flow.WppMessageFlowStep.length} steps`, {
				flowId: flow.id
			});

			const messageFlow = new MessageFlow();

			// Ordena os steps por stepNumber para garantir a ordem correta
			const sortedSteps = [...flow.WppMessageFlowStep].sort((a, b) => a.stepNumber - b.stepNumber);

			for (const step of sortedSteps) {
				// Usa os valores do banco de dados para next e fallback
				const stepConfig: any = {
					stepNumber: step.stepNumber,
					instance,
					sectorId,
					config: MessageFlowFactory.getValidatedStepConfig(step.config)
				};

				// Adiciona nextStepNumber se definido no banco
				if (step.nextStepId !== null && step.nextStepId !== undefined) {
					stepConfig.nextStepNumber = step.nextStepId;
				}

				// Adiciona fallbackStepNumber se definido no banco
				if (step.fallbackStepId !== null && step.fallbackStepId !== undefined) {
					stepConfig.fallbackStepNumber = step.fallbackStepId;
				}

				Logger.debug(`[MessageFlowFactory] Creating step from database`, {
					type: step.type,
					stepNumber: step.stepNumber,
					nextStepNumber: stepConfig.nextStepNumber,
					fallbackStepNumber: stepConfig.fallbackStepNumber,
					hasConfig: !!step.config
				});

				const stepInstance = this.createStep(
					step.type as string,
					instance,
					sectorId,
					step.stepNumber,
					stepConfig.nextStepNumber,
					stepConfig.config,
					stepConfig.fallbackStepNumber
				);
				
				messageFlow.addStep(stepInstance);
			}

			Logger.debug(
				`[MessageFlowFactory] Message flow created successfully with ${flow.WppMessageFlowStep.length} steps`
			);
			messageFlow.debugStepsMap();
			return messageFlow;
		} catch (error: any) {
			Logger.error(`[MessageFlowFactory] Failed to create message flow`, error);
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
