import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";

export default class CheckOnlyAdminStep extends BaseStep {
	constructor(config: StepConfig) {
		super(config);
	}

	public async execute(ctx: StepContext): Promise<StepResult> {
		ctx.logger.log("Verificando se o contato é apenas administrador...");

		if (ctx.contact.isOnlyAdmin) {
			ctx.logger.log("O contato é apenas administrador.");

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

		ctx.logger.log("O contato não é apenas administrador.");
		return this.continue(ctx);
	}
}
