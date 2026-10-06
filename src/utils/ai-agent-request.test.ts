import assert from "node:assert/strict";
import {
	AI_AGENT_MESSAGE_BODY_MAX,
	AI_AGENT_MESSAGE_TYPE_MAX,
	FLOW_AI_AGENT_CONTEXT_KEY,
	INTERNAL_SERVICE_TOKEN_HEADER,
	applyFlowAiAgentId,
	buildAiAgentProcessPayload,
	buildInternalServiceHeaders,
	getAiAgentProcessMessageUrl,
	getAiApiUrl,
	hasAiAgentChatId,
	resolveFlowAiAgentId,
	summarizeAiAgentProcessPayload
} from "./ai-agent-request";

// ─── Cabeçalho de autenticação interna (P20) ────────────────────────────────
assert.equal(INTERNAL_SERVICE_TOKEN_HEADER, "X-Internal-Service-Token");
assert.deepEqual(buildInternalServiceHeaders({}), {}, "sem a variável, nenhum cabeçalho é enviado");
assert.deepEqual(buildInternalServiceHeaders({ INTERNAL_SERVICE_TOKEN: "" }), {});
assert.deepEqual(buildInternalServiceHeaders({ INTERNAL_SERVICE_TOKEN: "   " }), {}, "só espaços conta como vazio");
assert.deepEqual(buildInternalServiceHeaders({ INTERNAL_SERVICE_TOKEN: "abc123" }), {
	"X-Internal-Service-Token": "abc123"
});
assert.deepEqual(buildInternalServiceHeaders({ INTERNAL_SERVICE_TOKEN: " abc123\n" }), {
	"X-Internal-Service-Token": "abc123"
}, "o token é enviado aparado");

// ─── URL do ai-service ──────────────────────────────────────────────────────
assert.equal(getAiApiUrl({}), "http://localhost:8008");
assert.equal(getAiApiUrl({ AI_API_URL: "" }), "http://localhost:8008", "valor vazio usa o padrão");
assert.equal(getAiApiUrl({ AI_API_URL: "http://10.0.0.5:9000" }), "http://10.0.0.5:9000");
assert.equal(getAiApiUrl({ AI_API_URL: "http://10.0.0.5:9000/" }), "http://10.0.0.5:9000", "barra final removida");
assert.equal(getAiApiUrl({ AI_API_URL: " http://ai.local// " }), "http://ai.local");
assert.equal(
	getAiAgentProcessMessageUrl({ AI_API_URL: "http://ai.local/" }),
	"http://ai.local/api/ai/agents/process-message"
);

// ─── Payload do process-message ─────────────────────────────────────────────
const base = {
	chatId: 123,
	instance: "tenant",
	contact: { id: 45, customerId: 678, phone: "5551999999999" },
	clientId: 3,
	agentId: null
};

// Sem mensagem: exatamente os campos que o ai-service já lia.
assert.deepEqual(buildAiAgentProcessPayload(base), {
	chatId: 123,
	instance: "tenant",
	contactId: 45,
	customerId: 678,
	phone: "5551999999999",
	clientId: 3,
	triggeredBy: "NEW_MESSAGE_NO_AGENT",
	agentId: null
});
assert.deepEqual(
	Object.keys(buildAiAgentProcessPayload({ ...base, message: null })),
	["chatId", "instance", "contactId", "customerId", "phone", "clientId", "triggeredBy", "agentId"]
);

// Com mensagem: messageId, messageBody (aparado) e messageType.
assert.deepEqual(
	buildAiAgentProcessPayload({
		...base,
		agentId: 7,
		contact: { id: 45, customerId: null, phone: "5551999999999" },
		clientId: null,
		message: { id: 9876, body: "  Quero um orçamento \n", type: "chat" }
	}),
	{
		chatId: 123,
		instance: "tenant",
		contactId: 45,
		customerId: null,
		phone: "5551999999999",
		clientId: null,
		triggeredBy: "NEW_MESSAGE_NO_AGENT",
		agentId: 7,
		messageId: 9876,
		messageBody: "Quero um orçamento",
		messageType: "chat"
	}
);

// Contato só com LID (sem telefone): o campo vai como veio.
assert.equal(
	buildAiAgentProcessPayload({ ...base, contact: { id: 46, customerId: null, phone: null } }).phone,
	null
);

// Corpo vazio ou só espaços é omitido; id inválido é omitido.
for (const body of ["", "   ", "\n\t", null, undefined]) {
	const payload = buildAiAgentProcessPayload({ ...base, message: { id: 1, body, type: "image" } });
	assert.equal("messageBody" in payload, false, `corpo ${JSON.stringify(body)} não deve ser enviado`);
	assert.equal(payload.messageId, 1);
	assert.equal(payload.messageType, "image");
}
for (const id of [0, -1, 1.5, Number.NaN, null, undefined]) {
	const payload = buildAiAgentProcessPayload({ ...base, message: { id, body: "oi" } });
	assert.equal("messageId" in payload, false, `id ${String(id)} não deve ser enviado`);
	assert.equal("messageType" in payload, false);
	assert.equal(payload.messageBody, "oi");
}

// Corpo longo é cortado em 2000 caracteres.
const longBody = "a".repeat(AI_AGENT_MESSAGE_BODY_MAX + 500);
const longPayload = buildAiAgentProcessPayload({ ...base, message: { id: 2, body: longBody, type: "chat" } });
assert.equal(longPayload.messageBody?.length, AI_AGENT_MESSAGE_BODY_MAX);
assert.equal(
	buildAiAgentProcessPayload({ ...base, message: { body: "b".repeat(AI_AGENT_MESSAGE_BODY_MAX) } }).messageBody?.length,
	AI_AGENT_MESSAGE_BODY_MAX,
	"exatamente 2000 caracteres não é cortado"
);

// O corte não deixa meio emoji no final.
const emojiBody = "a".repeat(AI_AGENT_MESSAGE_BODY_MAX - 1) + "😀" + "fim";
const emojiPayload = buildAiAgentProcessPayload({ ...base, message: { body: emojiBody } });
assert.equal(emojiPayload.messageBody, "a".repeat(AI_AGENT_MESSAGE_BODY_MAX - 1));

// messageType é limitado ao tamanho aceito pelo ai-service.
assert.equal(
	buildAiAgentProcessPayload({ ...base, message: { type: "x".repeat(AI_AGENT_MESSAGE_TYPE_MAX + 10) } }).messageType?.length,
	AI_AGENT_MESSAGE_TYPE_MAX
);
assert.equal("messageType" in buildAiAgentProcessPayload({ ...base, message: { type: "  " } }), false);

// ─── Step AI_AGENT: só aciona o ai-service quando a mensagem já tem chat ────
// (o ai-service devolve 400 sem chatId numérico; na criação do chat a mensagem ainda não tem chatId)
assert.equal(hasAiAgentChatId(123), true);
assert.equal(hasAiAgentChatId(1), true);
for (const chatId of [null, undefined, 0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
	assert.equal(hasAiAgentChatId(chatId), false, `chatId ${String(chatId)} não deve acionar o agente pelo step`);
}

// ─── Agente do step AI_AGENT gravado no chat criado pelo fluxo ──────────────
// (sem chatId o step não chama o ai-service; a distribuição envia chat.agentId)
assert.equal(FLOW_AI_AGENT_CONTEXT_KEY, "flowAiAgentId");
assert.equal(resolveFlowAiAgentId(7), 7);
for (const value of [undefined, null, 0, -1, 2.5, Number.NaN, "7", {}, true]) {
	assert.equal(resolveFlowAiAgentId(value), null, `config.agentId ${String(value)} = seleção automática`);
}

type FlowChat = { instance: string; sectorId: number; contactId: number; userId: number; agentId?: number | null };
const flowChat: FlowChat = { instance: "tenant", sectorId: 2, contactId: 45, userId: 10 };
assert.deepEqual(applyFlowAiAgentId(flowChat, 7), { ...flowChat, agentId: 7 }, "o chat nasce com o agente do fluxo");
assert.equal("agentId" in flowChat, false, "o payload original não é alterado");
assert.equal(applyFlowAiAgentId(flowChat, undefined), flowChat, "sem agente no fluxo, payload intacto (seleção automática)");
assert.equal("agentId" in (applyFlowAiAgentId(flowChat, "7") ?? {}), false, "agentId não numérico é ignorado");
assert.equal(applyFlowAiAgentId(null, 7), null, "sem payload, a validação do fluxo continua recusando");
assert.equal(applyFlowAiAgentId({ ...flowChat, agentId: 3 }, 7)?.agentId, 3, "agentId definido pelo step final prevalece");
assert.equal(applyFlowAiAgentId({ ...flowChat, agentId: null }, 7)?.agentId, null, "agentId nulo explícito do step final prevalece");

// ─── Resumo para log: sem o texto do cliente ────────────────────────────────
const summary = summarizeAiAgentProcessPayload(
	buildAiAgentProcessPayload({ ...base, message: { id: 3, body: "Meu CPF é 123", type: "chat" } })
);
assert.equal("messageBody" in summary, false);
assert.equal(summary.messageBodyLength, "Meu CPF é 123".length);
assert.equal(summary.messageId, 3);
assert.equal(JSON.stringify(summary).includes("CPF"), false);
assert.equal(summarizeAiAgentProcessPayload(buildAiAgentProcessPayload(base)).messageBodyLength, 0);

console.log("ai-agent-request: cabeçalho interno, URL do ai-service, payload do process-message, chatId e agente do step passed");
