import prismaService from "../../services/prisma.service";
import MessageFlow from "./message-flow";
import CheckAvailableUsersStep from "./steps/check-available-users.step";
import CheckLoaltyStep from "./steps/check-loalty.step";
import CheckOnlyAdminStep from "./steps/check-only-admin.step";
import SendToAdminStep from "./steps/send-to-admin.step";
import Step from "./steps/step";

const stepConstructors = {
	CHECK_ONLY_ADMIN: CheckOnlyAdminStep,
	CHECK_LOALTY: CheckLoaltyStep,
	CHECK_AVAILABLE_USERS: CheckAvailableUsersStep,
	SEND_TO_ADMIN: SendToAdminStep
};

export default class MessageFlowFactory {
	private static createStep(
		type: keyof typeof stepConstructors,
		instance: string,
		sectorId: number,
		stepId: number,
		nextStepId?: number
	): Step {
		const StepConstructor = stepConstructors[type];
		if (!StepConstructor) {
			throw new Error(`Step type ${type} is not supported.`);
		}
		return new StepConstructor({
			instance,
			sectorId,
			stepId,
			nextStepId: nextStepId ?? -1
		});
	}

	public static createDefaultMessageFlow(
		instance: string,
		sectorId: number
	): MessageFlow {
		const messageFlow = new MessageFlow();

		const steps = [
			{ type: "CHECK_ONLY_ADMIN", stepId: 1, nextStepId: 2 },
			{ type: "CHECK_LOALTY", stepId: 2, nextStepId: 3 },
			{ type: "CHECK_AVAILABLE_USERS", stepId: 3, nextStepId: 4 },
			{ type: "SEND_TO_ADMIN", stepId: 4 }
		];

		for (const stepConfig of steps) {
			const step = this.createStep(
				stepConfig.type as keyof typeof stepConstructors,
				instance,
				sectorId,
				stepConfig.stepId,
				stepConfig.nextStepId
			);
			messageFlow.addStep(step);
		}

		return messageFlow;
	}

	public static async createMessageFlow(
		instance: string,
		sectorId: number
	): Promise<MessageFlow> {
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
			const nextStepId =
				step.type === "SEND_TO_ADMIN" ? undefined : currentStepId + 1;
			const stepInstance = this.createStep(
				step.type as keyof typeof stepConstructors,
				instance,
				sectorId,
				currentStepId,
				nextStepId
			);
			messageFlow.addStep(stepInstance);
			currentStepId++;
		}

		return messageFlow;
	}
}
