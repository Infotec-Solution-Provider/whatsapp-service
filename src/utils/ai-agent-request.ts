/**
 * Montagem da chamada ao ai-service para o agente de IA reativo
 * (POST /api/ai/agents/process-message).
 *
 * Módulo puro: sem I/O, para ser usado tanto pela distribuição de mensagens
 * quanto pelo step AI_AGENT do MessageFlow e testado isoladamente.
 */

export const INTERNAL_SERVICE_TOKEN_HEADER = "X-Internal-Service-Token";
export const AI_AGENT_MESSAGE_BODY_MAX = 2000;
export const AI_AGENT_MESSAGE_TYPE_MAX = 32;
export const AI_AGENT_DEFAULT_API_URL = "http://localhost:8008";
export const AI_AGENT_PROCESS_MESSAGE_PATH = "/api/ai/agents/process-message";
export const AI_AGENT_TRIGGERED_BY = "NEW_MESSAGE_NO_AGENT";

type EnvSource = Record<string, string | undefined>;

export interface AiAgentProcessInput {
	chatId: number | null;
	instance: string;
	/** `phone` é nulo em contatos só com LID; vai como veio (o ai-service decide). */
	contact: { id: number; customerId: number | null; phone: string | null };
	clientId: number | null;
	agentId: number | null;
	message?: {
		id?: number | null | undefined;
		body?: string | null | undefined;
		type?: string | null | undefined;
	} | null | undefined;
}

export interface AiAgentProcessPayload {
	chatId: number | null;
	instance: string;
	contactId: number;
	customerId: number | null;
	phone: string | null;
	clientId: number | null;
	triggeredBy: typeof AI_AGENT_TRIGGERED_BY;
	agentId: number | null;
	messageId?: number;
	messageBody?: string;
	messageType?: string;
}

export type AiAgentProcessPayloadSummary = Omit<AiAgentProcessPayload, "messageBody"> & {
	messageBodyLength: number;
};

/**
 * Cabeçalho de autenticação interna (P20). Sem INTERNAL_SERVICE_TOKEN
 * configurado, nada é enviado e o ai-service aplica a regra legada.
 */
export function buildInternalServiceHeaders(env: EnvSource = process.env): Record<string, string> {
	const token = (env["INTERNAL_SERVICE_TOKEN"] ?? "").trim();

	return token ? { [INTERNAL_SERVICE_TOKEN_HEADER]: token } : {};
}

/** URL base do ai-service, lida a cada chamada (sem barra final). */
export function getAiApiUrl(env: EnvSource = process.env): string {
	const configured = (env["AI_API_URL"] ?? "").trim();

	return (configured || AI_AGENT_DEFAULT_API_URL).replace(/\/+$/, "");
}

export function getAiAgentProcessMessageUrl(env: EnvSource = process.env): string {
	return `${getAiApiUrl(env)}${AI_AGENT_PROCESS_MESSAGE_PATH}`;
}

/** Corta sem deixar meio caractere (par substituto) no final. */
function truncate(value: string, max: number): string {
	if (value.length <= max) {
		return value;
	}

	let cut = value.slice(0, max);
	const lastCode = cut.charCodeAt(cut.length - 1);
	if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
		cut = cut.slice(0, -1);
	}

	return cut.trimEnd();
}

export function normalizeAiAgentMessageBody(body: string | null | undefined): string | null {
	if (typeof body !== "string") {
		return null;
	}

	const trimmed = body.trim();
	if (!trimmed) {
		return null;
	}

	return truncate(trimmed, AI_AGENT_MESSAGE_BODY_MAX);
}

function normalizeMessageType(type: string | null | undefined): string | null {
	if (typeof type !== "string") {
		return null;
	}

	const trimmed = type.trim();
	return trimmed ? trimmed.slice(0, AI_AGENT_MESSAGE_TYPE_MAX) : null;
}

function normalizeMessageId(id: number | null | undefined): number | null {
	return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * O ai-service recusa o process-message sem chatId numérico (400). No step
 * AI_AGENT do MessageFlow, durante a criação do chat, a mensagem ainda não foi
 * gravada no chat (chatId nulo): chamar o ai-service nesse momento só gera uma
 * requisição recusada, e quem aciona o agente é a distribuição de mensagens.
 */
export function hasAiAgentChatId(chatId: number | null | undefined): chatId is number {
	return typeof chatId === "number" && Number.isInteger(chatId) && chatId > 0;
}

/**
 * Payload do process-message. Mantém os campos que o ai-service já lê e
 * acrescenta, quando houver, a mensagem que disparou a chamada (P21:
 * gatilho Palavra-chave): messageId, messageBody (aparado, até 2000
 * caracteres) e messageType.
 */
export function buildAiAgentProcessPayload(input: AiAgentProcessInput): AiAgentProcessPayload {
	const messageId = normalizeMessageId(input.message?.id);
	const messageBody = normalizeAiAgentMessageBody(input.message?.body);
	const messageType = normalizeMessageType(input.message?.type);

	return {
		chatId: input.chatId,
		instance: input.instance,
		contactId: input.contact.id,
		customerId: input.contact.customerId ?? null,
		phone: input.contact.phone,
		clientId: input.clientId,
		triggeredBy: AI_AGENT_TRIGGERED_BY,
		agentId: input.agentId,
		...(messageId !== null ? { messageId } : {}),
		...(messageBody !== null ? { messageBody } : {}),
		...(messageType !== null ? { messageType } : {})
	};
}

/** Versão do payload para log: sem o texto do cliente, só o tamanho. */
export function summarizeAiAgentProcessPayload(payload: AiAgentProcessPayload): AiAgentProcessPayloadSummary {
	const { messageBody, ...rest } = payload;

	return { ...rest, messageBodyLength: messageBody?.length ?? 0 };
}
