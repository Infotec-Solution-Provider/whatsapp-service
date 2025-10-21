import { User } from "@in.pulse-crm/sdk";
import instancesService from "../../services/instances.service";
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";

export default class SendToSectorUserStep extends BaseStep {
	constructor(config: StepConfig) {
		super(config);
	}

	public async execute(ctx: StepContext): Promise<StepResult> {
		ctx.logger.log("Enviando mensagem para um usuário do setor...");

		const users = await instancesService.executeQuery<User[]>(
			this.instance,
			"SELECT * FROM operadores WHERE SETOR = ?",
			[this.sectorId]
		);

		// Configuração: preferir admin se configurado
		const preferAdmin = this.config['preferAdmin'] !== false;
		const findAdmin = users.find((user) => user.NIVEL === "ADMIN");
		const findUser = users[0];

		const userId = preferAdmin 
			? (findAdmin?.CODIGO || findUser?.CODIGO || -1)
			: (findUser?.CODIGO || -1);

		const chatData = {
			instance: this.instance,
			type: "RECEPTIVE" as const,
			userId,
			sectorId: this.sectorId,
			contactId: ctx.contact.id
		};

		ctx.logger.log("Chat criado.", chatData);
		return this.finalize(chatData);
	}
}
