import type { NextFunction, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { Logger } from "@in.pulse-crm/utils";

/** Cabeçalho do segredo compartilhado entre whatsapp-service e ai-service. */
export const INTERNAL_SERVICE_TOKEN_HEADER = "X-Internal-Service-Token";

const LEGACY_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "::1"];
const FORBIDDEN_MESSAGE = "Acesso restrito a chamadas internas.";

/** Lê o segredo a cada chamada (sem cache) para refletir o ambiente atual; vazio = modo legado. */
export function getInternalServiceToken(env: NodeJS.ProcessEnv = process.env): string | null {
	const token = env["INTERNAL_SERVICE_TOKEN"]?.trim();

	return token ? token : null;
}

function sha256(value: string) {
	return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Compara os hashes (tamanho fixo) com timingSafeEqual: não vaza o comprimento
 * nem o conteúdo do segredo pelo tempo de resposta.
 */
export function isValidInternalServiceToken(supplied: unknown, expected: string): boolean {
	if (typeof supplied !== "string" || !supplied || typeof expected !== "string" || !expected) {
		return false;
	}

	return timingSafeEqual(sha256(supplied), sha256(expected));
}

function onlyLocal(req: Request, res: Response, next: NextFunction) {
	const expectedToken = getInternalServiceToken();

	if (expectedToken) {
		const suppliedToken = req.headers[INTERNAL_SERVICE_TOKEN_HEADER.toLowerCase()];

		if (!isValidInternalServiceToken(suppliedToken, expectedToken)) {
			Logger.debug(
				`[internal-auth] Chamada interna recusada (token ${suppliedToken === undefined ? "ausente" : "inválido"}): ${req.method} ${req.originalUrl || req.url} | ip=${req.ip ?? "desconhecido"}`
			);
			return res.status(403).json({ message: FORBIDDEN_MESSAGE });
		}

		return next();
	}

	const requestHost = req.hostname;

	if (!LEGACY_ALLOWED_HOSTS.includes(requestHost)) {
		Logger.debug(`Blocked request from non-localhost: ${requestHost}`);
		return res.status(403).json({ message: FORBIDDEN_MESSAGE });
	}

	return next();
}

if (!getInternalServiceToken()) {
	Logger.warning(
		"[internal-auth] INTERNAL_SERVICE_TOKEN não configurado: rotas /api/internal/whatsapp/* protegidas só pelo cabeçalho Host. Configure o mesmo valor no whatsapp-service e no ai-service."
	);
}

export default onlyLocal;
