import instances from "../../../services/instances.service";
import Step, { FinalStep, NextStep, StepContext } from "./step";
import prismaService from "../../../services/prisma.service";

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
			customerSchedule.OPERADOR
		);
		if (!isSameSector) {
			return this.nextStep(ctx, "O usuário não está no mesmo setor.");
		}

		const generatedChat = await this.createChat(
			ctx,
			customerSchedule.OPERADOR
		);
		ctx.logger.log("Chat criado com sucesso.", generatedChat);

		return { chat: generatedChat, isFinal: true };
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

	private async isUserInSameSector(userId: number): Promise<boolean> {
		const result = await prismaService.wppSectorUser.findUnique({
			where: { userId }
		});
		return result?.sectorId === this.sectorId;
	}

	private async createChat(ctx: StepContext, userId: number) {
		return prismaService.wppChat.create({
			data: {
				instance: this.instance,
				type: "RECEPTIVE",
				userId: userId,
				contactId: ctx.contact.id,
				sectorId: this.sectorId
			}
		});
	}

	private nextStep(ctx: StepContext, logMessage: string): NextStep {
		ctx.logger.log(logMessage);
		return { isFinal: false, stepId: this.nextStepId };
	}
}
