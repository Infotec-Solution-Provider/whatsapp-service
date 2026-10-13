export type SendFailureCategory = "CHANNEL" | "MESSAGE" | "UNCLASSIFIED";

/** Only recognizable evidence identifies a channel fault; generic refusals stay unclassified. */
export function sendFailureCategory(error: unknown): SendFailureCategory {
	const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (
		/invalid (?:recipient|number|jid|media|attachment)|not a whatsapp|not registered|blocked by|unsupported (?:media|message)|media (?:invalid|expired)|template (?:invalid|rejected|not found)|destinat[aá]rio (?:inv[aá]lido|bloqueado)|m[ií]dia (?:inv[aá]lida|expirada)/i.test(
			detail
		)
	) {
		return "MESSAGE";
	}
	if (
		/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|connection (?:closed|lost)|not connected|session (?:closed|disconnected)|canal indispon[ií]vel|sess[aã]o desconectada/i.test(
			detail
		)
	) {
		return "CHANNEL";
	}
	return "UNCLASSIFIED";
}
