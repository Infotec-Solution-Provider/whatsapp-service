/**
 * Regras únicas de contagem dos relatórios do painel, compartilhadas com as rotas BI.
 * As consultas SQL de operator-performance.service.ts seguem exatamente estas regras.
 */

export const SYSTEM_OPERATOR_ID = -1;
export const SYSTEM_OPERATOR_NAME = "Sistema/Admin";
export const EXCLUDED_OPERATOR_ID = 1;

export type ReportMessageType = "SENT" | "RECEIVED";

interface ReportMessageSource {
	from: string;
	to: string;
	userId?: number | null;
}

const isSystemOrThirdparty = (from: string, to: string) =>
	from.startsWith("system") ||
	to.startsWith("system") ||
	from.startsWith("thirdparty:") ||
	to.startsWith("thirdparty:") ||
	from.startsWith("bot") ||
	to.startsWith("bot");

/** Enviada (operação), recebida (cliente) ou null quando a mensagem não entra nos relatórios. */
export function getReportMessageType(message: ReportMessageSource): ReportMessageType | null {
	const from = String(message.from || "").toLowerCase();
	const to = String(message.to || "").toLowerCase();

	if ((message.userId !== null && message.userId !== undefined) || from.startsWith("me:") || from.startsWith("user:")) {
		return "SENT";
	}
	if (isSystemOrThirdparty(from, to)) return null;
	return /^[0-9]/.test(from) ? "RECEIVED" : null;
}

/**
 * Operador a quem os relatórios atribuem um registro: o código 1 fica de fora (null) e
 * responsáveis de sistema (<= 0) ou sem cadastro em `operadores` viram "Sistema/Admin".
 */
export function resolveReportUserId(operatorId: number | null | undefined, registeredOperators: { has(id: number): boolean }) {
	if (operatorId === null || operatorId === undefined || operatorId === EXCLUDED_OPERATOR_ID) return null;
	return operatorId > 0 && registeredOperators.has(operatorId) ? operatorId : SYSTEM_OPERATOR_ID;
}
