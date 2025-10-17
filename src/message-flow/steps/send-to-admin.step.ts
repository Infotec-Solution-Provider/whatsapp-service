import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";

export default class SendToAdminStep extends BaseStep {
	constructor(config: StepConfig) {
		super(config);
	}

	public async execute(ctx: StepContext): Promise<StepResult> {
		ctx.logger.log("Enviando mensagem para o administrador...");

		const chatData = {
			instance: this.instance,
			type: "RECEPTIVE" as const,
			userId: -1,
			sectorId: this.sectorId,
			contactId: ctx.contact.id
		};

		ctx.logger.log("Chat criado.", chatData);
		return this.finalize(chatData);
	}
}
