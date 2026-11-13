export const CUSTOMER_RESOLUTION_OPERATION = "resolveContactCustomer";
const RESERVED_CONTEXT_KEYS = new Set(["__proto__", "prototype", "constructor", "contact", "message", "logger", "instance", "sectorId", "customer", "legacyCampaignType", "legacySchedule"]);
export function isResolutionStoreAs(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !RESERVED_CONTEXT_KEYS.has(value);
}

/** Preserve unrelated options; remove only mutually exclusive SQL/operation settings when the user changes modes. */
export function changeQueryMode(config: Record<string, any>, mode: string): Record<string, any> {
	const result = { ...config };
	if (mode === CUSTOMER_RESOLUTION_OPERATION) {
		delete result["query"];
		delete result["params"];
		delete result["single"];
		delete result["required"];
		result["operation"] = CUSTOMER_RESOLUTION_OPERATION;
		if (!isResolutionStoreAs(result["storeAs"])) result["storeAs"] = "customerResolution";
	} else {
		delete result["operation"];
		if (typeof result["query"] !== "string") result["query"] = "";
	}
	return result;
}

export function stepConfigValidationError(type: string, config: Record<string, any>): string | null {
	if (type === "QUERY") {
		if (config["operation"] !== undefined) {
			if (config["operation"] !== CUSTOMER_RESOLUTION_OPERATION) return "Selecione uma operação de consulta disponível.";
			if (config["query"] !== undefined) return "A identificação do cliente e a consulta SQL são operações separadas.";
			if (!isResolutionStoreAs(config["storeAs"])) return "Informe uma variável de resultado válida, sem substituir os dados do contato ou da mensagem.";
		} else if (typeof config["query"] !== "string" || !config["query"].trim()) return "Informe a consulta SQL.";
		if (typeof config["storeAs"] !== "string" || !config["storeAs"].trim()) return "Informe a variável que receberá o resultado.";
	}
	if (type === "ASSIGN" && config["validateUser"] === true) {
		if (!Number.isSafeInteger(config["userId"]) || config["userId"] <= 0 || !Number.isSafeInteger(config["fallbackUserId"]) || config["fallbackUserId"] <= 0 || config["userId"] === config["fallbackUserId"])
			return "Informe usuários principal e de contingência válidos e diferentes.";
		if (config["walletId"] != null) return "A atribuição com validação de usuário deve usar somente usuários, sem carteira.";
	}
	return null;
}
