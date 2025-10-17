import instances from "../../services/instances.service";
import instancesService from "../../services/instances.service";
import { User } from "@in.pulse-crm/sdk";
import { BaseStep, StepConfig, StepContext, StepResult, CustomerSchedule } from "../base/base.step";

const CHECK_LOALTY_QUERY = `SELECT * FROM campanhas_clientes cc
            WHERE cc.CLIENTE = ?
            ORDER BY CODIGO DESC LIMIT 1;`;

export default class CheckLoaltyStep extends BaseStep {
	constructor(config: StepConfig) {
		super(config);
	}

	public async execute(ctx: StepContext): Promise<StepResult> {
		ctx.logger.log("Iniciando etapa de checagem de fidelização...");

		if (!ctx.contact.customerId) {
			ctx.logger.log("O contato não possui um ID de cliente.");
			return this.continue(ctx);
		}

		const customerSchedule = await this.fetchCustomerSchedule(ctx);
		if (!customerSchedule) {
			ctx.logger.log("Agendamento do cliente não encontrado.");
			return this.continue(ctx);
		}
		if (customerSchedule.OPERADOR === 0) {
			ctx.logger.log("O agendamento do cliente não possui um operador.");
			return this.continue(ctx);
		}

		const isSameSector = await this.isUserInSameSector(
			this.instance,
			customerSchedule.OPERADOR
		);
		if (!isSameSector) {
			ctx.logger.log("O usuário não está no mesmo setor.");
			return this.continue(ctx);
		}

		const chatData = {
			instance: this.instance,
			type: "RECEPTIVE" as const,
			userId: customerSchedule.OPERADOR,
			contactId: ctx.contact.id,
			sectorId: this.sectorId
		};

		ctx.logger.log("Chat criado com sucesso.", chatData);

		return this.finalize(chatData);
	}

	private async fetchCustomerSchedule(
		ctx: StepContext
	): Promise<CustomerSchedule | null> {
		ctx.logger.log("Buscando agendamento do cliente...");
		const result = await instances.executeQuery<Array<CustomerSchedule>>(
			this.instance,
			CHECK_LOALTY_QUERY,
			[ctx.contact.customerId]
		);
		return result[0] || null;
	}

	private async isUserInSameSector(
		instance: string,
		userId: number
	): Promise<boolean> {
		const users = await instancesService.executeQuery<User[]>(
			instance,
			"SELECT * FROM operadores WHERE CODIGO = ?",
			[userId]
		);

		return users.length > 0 && users[0]!.SETOR === this.sectorId;
	}
}
