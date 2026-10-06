import axios from "axios";
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";
import {
	buildAiAgentProcessPayload,
	buildInternalServiceHeaders,
	getAiAgentProcessMessageUrl
} from "../../utils/ai-agent-request";

export default class AiAgentStep extends BaseStep {
	constructor(config: StepConfig) {
		super(config);
	}

	public async execute(ctx: StepContext): Promise<StepResult> {
		ctx.logger.log("Ativando agente de IA para o chat...");

		const agentId: number | null = typeof this.config["agentId"] === "number"
			? this.config["agentId"]
			: null;

		try {
			const payload = buildAiAgentProcessPayload({
				chatId: ctx.message.chatId,
				instance: this.instance,
				contact: {
					id: ctx.contact.id,
					customerId: ctx.contact.customerId ?? null,
					phone: ctx.contact.phone
				},
				clientId: ctx.message.clientId ?? null,
				agentId,
				message: { id: ctx.message.id, body: ctx.message.body, type: ctx.message.type }
			});

			await axios.post(
				getAiAgentProcessMessageUrl(),
				payload,
				{ timeout: 30000, headers: buildInternalServiceHeaders() }
			);

			ctx.logger.log("Agente de IA processou a mensagem com sucesso.");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.logger.log(`Erro ao acionar agente de IA: ${msg}`);
		}

		// AI_AGENT step is terminal — does not assign chatData; returns current context
		return {
			isFinal: false,
			...(this.nextStepNumber !== undefined ? { nextStepNumber: this.nextStepNumber } : {}),
			context: ctx
		};
	}
}
