import axios from "axios";
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";
import {
	buildAiAgentProcessPayload,
	buildInternalServiceHeaders,
	FLOW_AI_AGENT_CONTEXT_KEY,
	getAiAgentProcessMessageUrl,
	hasAiAgentChatId,
	resolveFlowAiAgentId
} from "../../utils/ai-agent-request";

export default class AiAgentStep extends BaseStep {
	constructor(config: StepConfig) {
		super(config);
	}

	public async execute(ctx: StepContext): Promise<StepResult> {
		const chatId = ctx.message.chatId;
		const configuredAgentId = this.config["agentId"];
		const agentId = resolveFlowAiAgentId(configuredAgentId);

		if (agentId === null && configuredAgentId !== undefined && configuredAgentId !== null) {
			ctx.logger.log(`agentId inválido no step AI_AGENT (${String(configuredAgentId)}); a seleção do agente de IA fica automática.`);
		}

		// O agente do fluxo vai no contexto para o chat nascer com agent_id (MessageFlow → applyFlowAiAgentId).
		const nextCtx: StepContext = agentId !== null ? { ...ctx, [FLOW_AI_AGENT_CONTEXT_KEY]: agentId } : ctx;

		if (!hasAiAgentChatId(chatId)) {
			// Chat ainda em criação: o ai-service recusaria a chamada (400) e a
			// distribuição de mensagens aciona o agente depois de gravar a mensagem no chat.
			ctx.logger.log(
				agentId !== null
					? `Mensagem ainda sem chat; o agente de IA #${agentId} do fluxo será gravado no chat e acionado pela distribuição de mensagens.`
					: "Mensagem ainda sem chat; o step não aciona o agente de IA (o acionamento fica com a distribuição de mensagens)."
			);
			return this.continueFlow(nextCtx);
		}

		ctx.logger.log("Ativando agente de IA para o chat...");

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

		return this.continueFlow(nextCtx);
	}

	private continueFlow(ctx: StepContext): StepResult {
		// AI_AGENT não finaliza o fluxo nem monta chatData: o agente configurado segue
		// no contexto e o MessageFlow o copia para o chatData do step final.
		return {
			isFinal: false,
			...(this.nextStepNumber !== undefined ? { nextStepNumber: this.nextStepNumber } : {}),
			context: ctx
		};
	}
}
