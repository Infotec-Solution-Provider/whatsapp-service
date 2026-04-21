import axios from "axios";
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";

const AI_API_URL = process.env["AI_API_URL"] || "http://localhost:8008";

export default class AiAgentStep extends BaseStep {
	constructor(config: StepConfig) {
		super(config);
	}

	public async execute(ctx: StepContext): Promise<StepResult> {
		ctx.logger.log("Ativando agente de IA para o chat...");

		const agentId: number | undefined = typeof this.config["agentId"] === "number"
			? this.config["agentId"]
			: undefined;

		try {
			await axios.post(
				`${AI_API_URL}/api/ai/agents/process-message`,
				{
					chatId: ctx.message.chatId,
					instance: this.instance,
					contactId: ctx.contact.id,
					customerId: ctx.contact.customerId ?? null,
					phone: ctx.contact.phone,
					clientId: ctx.message.clientId ?? null,
					triggeredBy: "NEW_MESSAGE_NO_AGENT",
					...(agentId !== undefined && { agentId })
				},
				{ timeout: 30000 }
			);

			ctx.logger.log("Agente de IA processou a mensagem com sucesso.");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.logger.log(`Erro ao acionar agente de IA: ${msg}`);
		}

		// AI_AGENT step is terminal — does not assign chatData; returns current context
		return {
			isFinal: false,
			nextStepNumber: this.nextStepNumber,
			context: ctx
		};
	}
}
