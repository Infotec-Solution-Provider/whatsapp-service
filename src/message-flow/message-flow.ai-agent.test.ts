import assert from "node:assert/strict";
import axios from "axios";
import type { WppContact, WppMessage } from "@prisma/client";
import type ProcessingLogger from "../utils/processing-logger";
import { BaseStep, ChatPayload, StepContext, StepResult } from "./base/base.step";
import MessageFlow from "./message-flow";
import AiAgentStep from "./steps/ai-agent.step";

// O agentId do step AI_AGENT precisa chegar ao chat criado pelo fluxo: na criação
// do chat a mensagem ainda não tem chatId, o step não chama o ai-service e a
// distribuição de mensagens aciona o agente com chat.agentId.

class FinalStep extends BaseStep {
	public async execute(_ctx: StepContext): Promise<StepResult> {
		return this.finalize({ ...this.config["chatData"] } as ChatPayload);
	}
}

const logger = { log: () => {}, debug: () => {}, failed: () => {}, success: () => {} } as unknown as ProcessingLogger;
const contact = { id: 45, customerId: 678, phone: "5551999999999", name: "Cliente" } as unknown as WppContact;

function buildMessage(chatId: number | null): WppMessage {
	return { id: 9876, chatId, clientId: 3, body: "Quero um orçamento", type: "chat" } as unknown as WppMessage;
}

const finalChatData: ChatPayload = { instance: "tenant", type: "RECEPTIVE", sectorId: 2, contactId: 45, userId: 10 };

function buildFlow(aiAgentConfig: Record<string, unknown>, chatData: ChatPayload = finalChatData): MessageFlow {
	const flow = new MessageFlow();
	flow.addStep(new AiAgentStep({ stepNumber: 1, instance: "tenant", sectorId: 2, config: aiAgentConfig, nextStepNumber: 2 }));
	flow.addStep(new FinalStep({ stepNumber: 2, instance: "tenant", sectorId: 2, config: { chatData } }));
	return flow;
}

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
const originalPost = axios.post;
axios.post = (async (url: string, body: Record<string, unknown>) => {
	calls.push({ url, body });
	return { data: { message: "ok", data: null } };
}) as typeof axios.post;

async function main() {
	// Chat novo (mensagem sem chatId): sem chamada ao ai-service e o chat nasce com o agente do fluxo.
	const created = await buildFlow({ agentId: 7 }).getChatPayload(logger, contact, buildMessage(null));
	assert.equal(calls.length, 0, "sem chatId o step não chama o ai-service");
	assert.deepEqual(created, { ...finalChatData, agentId: 7 }, "o chatData do step final ganha o agente do fluxo");

	// Sem agentId no step: seleção automática, payload igual ao do step final.
	const automatic = await buildFlow({}).getChatPayload(logger, contact, buildMessage(null));
	assert.deepEqual(automatic, finalChatData);
	assert.equal("agentId" in automatic, false);

	// agentId inválido na configuração: ignorado (seleção automática).
	for (const agentId of ["7", 0, -3, 1.5]) {
		const invalid = await buildFlow({ agentId }).getChatPayload(logger, contact, buildMessage(null));
		assert.equal("agentId" in invalid, false, `agentId ${String(agentId)} não vai para o chat`);
	}

	// O step final que já define agentId prevalece.
	const explicit = await buildFlow({ agentId: 7 }, { ...finalChatData, agentId: 3 }).getChatPayload(
		logger,
		contact,
		buildMessage(null)
	);
	assert.equal(explicit.agentId, 3);

	// Mensagem já no chat (execução manual do fluxo): o step chama o ai-service com o agente do fluxo.
	const existing = await buildFlow({ agentId: 7 }).getChatPayload(logger, contact, buildMessage(55));
	assert.equal(calls.length, 1, "com chatId o step chama o ai-service uma vez");
	assert.equal(calls[0]!.url.endsWith("/api/ai/agents/process-message"), true);
	assert.equal(calls[0]!.body["chatId"], 55);
	assert.equal(calls[0]!.body["agentId"], 7);
	assert.equal(existing.agentId, 7);

	console.log("message-flow AI_AGENT: agente do fluxo gravado no chat criado passed");
}

main()
	.finally(() => {
		axios.post = originalPost;
	})
	.catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
