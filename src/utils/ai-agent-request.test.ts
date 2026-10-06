import assert from "node:assert/strict";
import {
	AI_AGENT_MESSAGE_BODY_MAX,
	AI_AGENT_MESSAGE_TYPE_MAX,
	INTERNAL_SERVICE_TOKEN_HEADER,
	buildAiAgentProcessPayload,
	buildInternalServiceHeaders,
	getAiAgentProcessMessageUrl,
	getAiApiUrl,
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

// ─── Resumo para log: sem o texto do cliente ────────────────────────────────
const summary = summarizeAiAgentProcessPayload(
	buildAiAgentProcessPayload({ ...base, message: { id: 3, body: "Meu CPF é 123", type: "chat" } })
);
assert.equal("messageBody" in summary, false);
assert.equal(summary.messageBodyLength, "Meu CPF é 123".length);
assert.equal(summary.messageId, 3);
assert.equal(JSON.stringify(summary).includes("CPF"), false);
assert.equal(summarizeAiAgentProcessPayload(buildAiAgentProcessPayload(base)).messageBodyLength, 0);

console.log("ai-agent-request: cabeçalho interno, URL do ai-service e payload do process-message passed");
