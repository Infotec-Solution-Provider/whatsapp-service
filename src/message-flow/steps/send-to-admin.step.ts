import prismaService from "../../services/prisma.service";
import Step, { FinalStep, StepContext } from "./step";

interface SendToAdminStepOptions {
	instance: string;
	stepId: number;
	sectorId: number;
}

export default class SendToAdminStep implements Step {
	private readonly instance: string;
	private readonly sectorId: number;
	public readonly id: number;

	constructor({ instance, stepId, sectorId }: SendToAdminStepOptions) {
		this.id = stepId;
		this.instance = instance;
		this.sectorId = sectorId;
	}

	public async run(ctx: StepContext): Promise<FinalStep> {
		ctx.logger.log("Enviando mensagem para o administrador...");
		const chatData = {
			instance: this.instance,
			type: "RECEPTIVE",
			userId: -1,
			sectorId: this.sectorId,
			contactId: ctx.contact.id
		};

		ctx.logger.log("Chat criado.", chatData);

		return {
			isFinal: true,
			chatData
		};
	}
}
