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
		stepId: number,
		nextStepId?: number,
		config?: Record<string, any>
	): BaseStep {
		const stepConfig: any = {
			id: stepId,
			instance,
			sectorId,
			config: config || {}            
		};

		if (nextStepId !== undefined) {
			stepConfig.nextStepId = nextStepId;
		}

		return StepRegistry.create(type, stepConfig);
	}

	public static createDefaultMessageFlow(instance: string, sectorId: number): MessageFlow {
		const messageFlow = new MessageFlow();

		const steps = [
			{ type: "CHECK_ONLY_ADMIN", stepId: 1, nextStepId: 2 },
			{ type: "CHECK_LOALTY", stepId: 2, nextStepId: 3 },
			{ type: "CHECK_AVAILABLE_USERS", stepId: 3, nextStepId: 4 },
			{ type: "SEND_TO_ADMIN", stepId: 4 }
		];

		for (const stepConfig of steps) {
			const step = this.createStep(stepConfig.type, instance, sectorId, stepConfig.stepId, stepConfig.nextStepId);
			messageFlow.addStep(step);
		}

		return messageFlow;
	}

	public static async createMessageFlow(instance: string, sectorId: number): Promise<MessageFlow> {
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
		let currentStepId = 1;

		for (const step of flow.WppMessageFlowStep) {
			const nextStepId = step.type === "SEND_TO_ADMIN" ? undefined : currentStepId + 1;
			const stepInstance = this.createStep(step.type as string, instance, sectorId, currentStepId, nextStepId);
			messageFlow.addStep(stepInstance);
			currentStepId++;
		}

		return messageFlow;
	}
}
