import { User } from "@in.pulse-crm/sdk";
import instancesService from "../../services/instances.service";
import Step, { ChatPayload, FinalStep, StepContext } from "./step";

interface SendToAdminStepOptions {
	instance: string;
	stepId: number;
	sectorId: number;
}

export default class SendToSectorUserStep implements Step {
	private readonly instance: string;
	private readonly sectorId: number;
	public readonly id: number;

	constructor({ instance, stepId, sectorId }: SendToAdminStepOptions) {
		this.id = stepId;
		this.instance = instance;
		this.sectorId = sectorId;
	}

	public async run(ctx: StepContext): Promise<FinalStep> {
		ctx.logger.log("Enviando mensagem para um usuário do setor...");

		const users = await instancesService.executeQuery<User[]>(
			this.instance,
			"SELECT * FROM operadores WHERE SETOR = ?",
			[this.sectorId]
		);

		const findAdmin = users.find((user) => user.NIVEL === "ADMIN");
		const findUser = users[0];

		const chatData: ChatPayload = {
			instance: this.instance,
			type: "RECEPTIVE",
			userId: findAdmin?.CODIGO || findUser?.CODIGO || -1,
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
