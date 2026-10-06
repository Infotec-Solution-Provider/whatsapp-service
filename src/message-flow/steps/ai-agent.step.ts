import axios from "axios";
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";
import {
	buildAiAgentProcessPayload,
	buildInternalServiceHeaders,
	getAiAgentProcessMessageUrl,
	hasAiAgentChatId
} from "../../utils/ai-agent-request";

export default class AiAgentStep extends BaseStep {
	constructor(config: StepConfig) {
		super(config);
	}

	public async execute(ctx: StepContext): Promise<StepResult> {
		const chatId = ctx.message.chatId;

		if (!hasAiAgentChatId(chatId)) {
			// Chat ainda em criação: o ai-service recusaria a chamada (400) e a
			// distribuição de mensagens aciona o agente depois de gravar a mensagem no chat.
			ctx.logger.log("Mensagem ainda sem chat; o step não aciona o agente de IA (o acionamento fica com a distribuição de mensagens).");
			return this.continueFlow(ctx);
		}

		ctx.logger.log("Ativando agente de IA para o chat...");

		const agentId: number | null = typeof this.config["agentId"] === "number"
			? this.config["agentId"]
			: null;

		try {
			const payload = buildAiAgentProcessPayload({
				chatId,
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

		return this.continueFlow(ctx);
	}

	private continueFlow(ctx: StepContext): StepResult {
		// AI_AGENT step is terminal — does not assign chatData; returns current context
		return {
			isFinal: false,
			...(this.nextStepNumber !== undefined ? { nextStepNumber: this.nextStepNumber } : {}),
			context: ctx
		};
	}
}
