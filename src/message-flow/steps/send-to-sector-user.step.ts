import { User } from "../../sdk-local";
import instancesService from "../../services/instances.service";
import { pauseEligibleOperatorIds } from "../../services/central-operator-admission.runtime";
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";

export default class SendToSectorUserStep extends BaseStep {
	constructor(config: StepConfig) {
		super(config);
	}

	public async execute(ctx: StepContext): Promise<StepResult> {
		ctx.logger.log("Enviando mensagem para um usuário do setor...");

		const candidates = await instancesService.executeQuery<User[]>(
			this.instance,
			"SELECT * FROM operadores WHERE SETOR = ?",
			[this.sectorId]
		);
		const eligible = await pauseEligibleOperatorIds(this.instance, candidates.map(user => user.CODIGO));
		const users = candidates.filter(user => eligible.has(user.CODIGO));

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
