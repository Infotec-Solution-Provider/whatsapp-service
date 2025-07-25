import instances from "../../services/instances.service";
import Step, { ChatPayload, FinalStep, NextStep, StepContext } from "./step";
import instancesService from "../../services/instances.service";
import { User } from "@in.pulse-crm/sdk";

interface CustomerSchedules {
	CODIGO: number;
	CLIENTE: number;
	CAMPANHA: number;
	DT_RESULTADO: Date | null;
	DT_AGENDAMENTO: Date;
	RESULTADO: number;
	CONCLUIDO: "SIM" | "NAO";
	FONE1: string;
	FONE2: string;
	FONE3: string;
	ORDEM: number;
	OPERADOR: number;
	OPERADOR_LIGACAO: number;
	DATA_HORA_LIG: Date | null;
	TELEFONE_LIGADO: string | null;
	DATA_HORA_FIM: Date | null;
	AGENDA: number;
	DESC_FONE1: string | null;
	DESC_FONE2: string | null;
	DESC_FONE3: string | null;
	FIDELIZA: "S" | "N";
	MANUAL: "S" | "N";
}

interface CheckLoaltyStepOptions {
	instance: string;
	sectorId: number;
	stepId: number;
	nextStepId: number;
}

const CHECK_LOALTY_QUERY = `SELECT * FROM campanhas_clientes cc
            WHERE cc.CLIENTE = ?
            ORDER BY CODIGO DESC LIMIT 1;`;

export default class CheckLoaltyStep implements Step {
	private readonly instance: string;
	private readonly sectorId: number;
	private readonly nextStepId: number;
	public readonly id: number;

	constructor({
		instance,
		sectorId,
		stepId,
		nextStepId
	}: CheckLoaltyStepOptions) {
		this.instance = instance;
		this.sectorId = sectorId;
		this.nextStepId = nextStepId;
		this.id = stepId;
	}

	public async run(ctx: StepContext): Promise<NextStep | FinalStep> {
		ctx.logger.log("Iniciando etapa de checagem de fidelização...");

		if (!ctx.contact.customerId) {
			return this.nextStep(ctx, "O contato não possui um ID de cliente.");
		}

		const customerSchedule = await this.fetchCustomerSchedule(ctx);
		if (!customerSchedule) {
			return this.nextStep(ctx, "Agendamento do cliente não encontrado.");
		}
		if (customerSchedule.OPERADOR === 0) {
			const msg = "O agendamento do cliente não possui um operador.";
			return this.nextStep(ctx, msg);
		}

		const isSameSector = await this.isUserInSameSector(
			this.instance,
			customerSchedule.OPERADOR
		);
		if (!isSameSector) {
			return this.nextStep(ctx, "O usuário não está no mesmo setor.");
		}

		const chatData: ChatPayload = {
			instance: this.instance,
			type: "RECEPTIVE",
			userId: customerSchedule.OPERADOR,
			contactId: ctx.contact.id,
			sectorId: this.sectorId
		};

		ctx.logger.log("Chat criado com sucesso.", chatData);

		return { chatData, isFinal: true };
	}

	private async fetchCustomerSchedule(
		ctx: StepContext
	): Promise<CustomerSchedules | null> {
		ctx.logger.log("Buscando agendamento do cliente...");
		const result = await instances.executeQuery<Array<CustomerSchedules>>(
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

	private nextStep(ctx: StepContext, logMessage: string): NextStep {
		ctx.logger.log(logMessage);
		return { isFinal: false, stepId: this.nextStepId };
	}
}
