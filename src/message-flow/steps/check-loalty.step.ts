import { distributionReads, FlowDistributionReads } from "../distribution-reads";
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";

export default class CheckLoaltyStep extends BaseStep {
	constructor(config: StepConfig, private readonly reads: FlowDistributionReads = distributionReads) {
		super(config);
	}

	public async execute(ctx: StepContext): Promise<StepResult> {
		ctx.logger.log("Iniciando etapa de checagem de fidelização...");

		if (!ctx.contact.customerId) {
			ctx.logger.log("O contato não possui um ID de cliente.");
			return this.continue(ctx, undefined, "Contato sem cliente vinculado.");
		}

		const operatorId = await this.reads.loyalty(this.instance, ctx.contact.customerId);
		if (operatorId === null) {
			ctx.logger.log("Agendamento do cliente não encontrado.");
			return this.continue(ctx, undefined, "Cliente sem registro de fidelização.");
		}
		if (operatorId === 0) {
			ctx.logger.log("O agendamento do cliente não possui um operador.");
			return this.continue(ctx, undefined, "Fidelização sem operador.");
		}

		const [operator] = await this.reads.operators(this.instance, [operatorId]);
		if (!operator || operator.SETOR !== this.sectorId) {
			ctx.logger.log("O usuário não está no mesmo setor.");
			return this.continue(ctx, undefined, "Operador de fidelização de outro setor ou inexistente.");
		}
		if (!(await this.reads.eligible(this.instance, [operatorId])).has(operatorId)) return this.continue(ctx, undefined, "Operador de fidelização indisponível.");

		const chatData = {
			instance: this.instance,
			type: "RECEPTIVE" as const,
			userId: operatorId,
			contactId: ctx.contact.id,
			sectorId: this.sectorId
		};

		ctx.logger.log("Chat criado com sucesso.", chatData);

		return this.finalize(chatData, "Encaminhado ao operador de fidelização do setor.");
	}

}
