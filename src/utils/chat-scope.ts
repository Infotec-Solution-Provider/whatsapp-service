import { BadRequestError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local/types/auth.types";

/**
 * Escopo das buscas de chat: sempre o tenant e, quando a regra de visibilidade
 * exigir, também o setor.
 */
export interface ChatScope {
	instance: string;
	sectorId?: number | null;
}

/** Tenant em que operadores fora do setor de TI só leem mensagens do próprio setor. */
const SECTOR_RESTRICTED_INSTANCE = "nunes";
const SECTOR_RESTRICTED_BYPASS_SECTOR_ID = 3;

/** Usuário fictício das ações do agente virtual (mesmo valor das finalizações pelo sistema). */
export const SYNTHETIC_AGENT_USER_ID = -1;
export const SYNTHETIC_AGENT_USER_NAME = "Agente virtual";

const AGENT_NAME_MAX_LENGTH = 120;
const OPERATOR_NAME_MAX_LENGTH = 120;
const AGENT_REASON_MAX_LENGTH = 500;
/** chat_transfer_history.reason é VARCHAR(255). */
const TRANSFER_HISTORY_REASON_MAX_LENGTH = 255;

/** Escopo para abrir um chat pela sessão: só o tenant (sem a regra de setor, para não esconder chats de outros setores). */
export function chatScopeFromSession(session: Pick<SessionData, "instance">): ChatScope {
	return { instance: session.instance };
}

/** Escopo das rotas de mensagens: mantém a regra de setor da nunes (setor 3 vê todos). */
export function messagesScopeFromSession(session: Pick<SessionData, "instance" | "sectorId">): ChatScope {
	if (session.instance === SECTOR_RESTRICTED_INSTANCE && session.sectorId !== SECTOR_RESTRICTED_BYPASS_SECTOR_ID) {
		return { instance: session.instance, sectorId: session.sectorId };
	}

	return { instance: session.instance };
}

/** Inteiro positivo vindo de número ou texto só com dígitos; qualquer outra coisa vira null. */
export function parsePositiveInt(value: unknown): number | null {
	let parsed: number;

	if (typeof value === "number") {
		parsed = value;
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		parsed = Number(value.trim());
	} else {
		return null;
	}

	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * `instance` opcional das rotas internas (o ai-service antigo não envia): texto
 * não vazio restringe ao tenant; ausente, nulo ou vazio = sem escopo (legado).
 */
export function parseOptionalInstance(value: unknown): string | null {
	if (value === undefined || value === null) {
		return null;
	}

	if (typeof value !== "string") {
		throw new BadRequestError("O campo instance deve ser um texto.");
	}

	return value.trim() || null;
}

/** Sessão sem usuário real para reaproveitar fluxos que exigem SessionData (finalizar, enviar template). */
export function buildSyntheticSession(instance: string, sectorId?: number | null): SessionData {
	return {
		instance,
		userId: SYNTHETIC_AGENT_USER_ID,
		sectorId: sectorId ?? -1,
		role: "ADMIN",
		name: SYNTHETIC_AGENT_USER_NAME
	};
}

/** Texto em uma linha: espaços e quebras colapsados, aparado e limitado; vazio ou não texto = null. */
export function normalizeInlineText(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const text = value.replace(/\s+/g, " ").trim().slice(0, maxLength).trim();

	return text ? text : null;
}

function agentLabel(agentName: string | null | undefined, agentId: number) {
	const name = normalizeInlineText(agentName, AGENT_NAME_MAX_LENGTH);

	return name ? `“${name}”` : `#${agentId}`;
}

function operatorLabel(operatorName: string | null | undefined, operatorId: number) {
	return normalizeInlineText(operatorName, OPERATOR_NAME_MAX_LENGTH) ?? `#${operatorId}`;
}

/** Mensagem de sistema da transferência feita pelo agente virtual (único dono do texto). */
export function buildAgentTransferMessage(
	agentName: string | null | undefined,
	agentId: number,
	operatorName: string | null | undefined,
	operatorId: number
) {
	return `Atendimento transferido pelo agente virtual ${agentLabel(agentName, agentId)} para ${operatorLabel(operatorName, operatorId)}.`;
}

/** Mensagem de sistema do encerramento pelo agente virtual; a linha “Motivo:” só aparece com motivo. */
export function buildAgentFinishMessage(
	agentName: string | null | undefined,
	agentId: number,
	reason?: string | null
) {
	const message = `Atendimento finalizado pelo agente virtual ${agentLabel(agentName, agentId)}.`;
	const motive = normalizeInlineText(reason, AGENT_REASON_MAX_LENGTH);

	return motive ? `${message}\nMotivo: ${motive}` : message;
}

/** Motivo gravado em chat_transfer_history: identifica o agente, já que não há usuário iniciador. */
export function buildAgentTransferHistoryReason(agentId: number, reason?: string | null) {
	const motive = normalizeInlineText(reason, TRANSFER_HISTORY_REASON_MAX_LENGTH);
	const text = motive ? `Agente virtual #${agentId}: ${motive}` : `Transferência pelo agente virtual #${agentId}`;

	return text.slice(0, TRANSFER_HISTORY_REASON_MAX_LENGTH);
}

/**
 * Mensagem de finalização sem usuário (sistema): o resultado só aparece quando não
 * é o resultado de sistema (−50) e foi encontrado; o motivo é mantido como veio.
 */
export function buildSystemFinishMessage(resultName: string | null | undefined, reason?: string | null) {
	const resultLine = resultName?.trim() ? `\nResultado: ${resultName.trim()}` : "";
	const reasonLine = reason ? `\nMotivo: ${reason}` : "";

	return `Atendimento finalizado pelo sistema.${resultLine}${reasonLine}`;
}
