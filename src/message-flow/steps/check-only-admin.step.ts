import Step, { ChatPayload, FinalStep, NextStep, StepContext } from "./step";

interface CheckOnlyAdminStepOptions {
	instance: string;
	sectorId: number;
	stepId: number;
	nextStepId: number;
}

export default class CheckOnlyAdminStep implements Step {
	private readonly instance: string;
	private readonly sectorId: number;
	private readonly nextStepId: number;
	public readonly id: number;

	constructor({
		instance,
		sectorId,
		stepId,
		nextStepId
	}: CheckOnlyAdminStepOptions) {
		this.instance = instance;
		this.sectorId = sectorId;
		this.nextStepId = nextStepId;
		this.id = stepId;
	}

	public async run(ctx: StepContext): Promise<NextStep | FinalStep> {
		ctx.logger.log("Verificando se o contato é apenas administrador...");

		if (ctx.contact.isOnlyAdmin) {
			ctx.logger.log("O contato é apenas administrador.");

			const chatData: ChatPayload = {
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
		ctx.logger.log("O contato não é apenas administrador.");

		return {
			isFinal: false,
			stepId: this.nextStepId
		};
	}
}
