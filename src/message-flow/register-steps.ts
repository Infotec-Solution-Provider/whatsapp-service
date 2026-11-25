import { StepRegistry } from "./step-registry";

// Base steps (genéricos e reutilizáveis)
import { AssignStep } from "./base/assign.step";
import { ConditionStep } from "./base/condition.step";
import { QueryStep } from "./base/query.step";
import { RouterStep } from "./base/router.step";

// Business steps (específicos do domínio - todos refatorados)
import CheckAvailableUsersStep from "./steps/check-available-users.step";
import CheckLoyaltyStep from "./steps/check-loalty.step";
import CheckOnlyAdminStep from "./steps/check-only-admin.step";
import CheckUserOnlineStep from "./steps/check-user-online.step";
import SendToAdminStep from "./steps/send-to-admin.step";
import SendToSectorUserStep from "./steps/send-to-sector-user.step";
import AiAgentStep from "./steps/ai-agent.step";
import StartBotStep from "./steps/start-bot.step";

/**
 * Registra todos os steps disponíveis no sistema.
 * Este arquivo é carregado automaticamente ao iniciar a aplicação.
 */
export function registerAllSteps(): void {
	StepRegistry.register("START_BOT", StartBotStep, {
		description: "Inicia o bot publicado para o canal de atendimento",
		requiredConfig: ["botId"],
		validateConfig: (config) => {
			if (!Number.isSafeInteger(config["botId"]) || config["botId"] <= 0) throw Error("Selecione um bot válido.");
		}
	});
	// ===== BASE STEPS (Genéricos) =====

	StepRegistry.register("CONDITION", ConditionStep, {
		description: "Avalia uma condição e direciona baseado no resultado",
		requiredConfig: ["field", "operator", "value"],
		optionalConfig: []
	});

	StepRegistry.register("QUERY", QueryStep, {
		description: "Consulta SQL ou resolve e vincula o cliente do contato",
		requiredConfig: ["storeAs"],
		optionalConfig: ["query", "operation", "params", "single", "required"],
		validateConfig: (config) => {
			if (typeof config["storeAs"] !== "string" || !config["storeAs"].trim()) throw new Error("QUERY requires storeAs");
			if (config["operation"] !== undefined) {
				if (config["operation"] !== "resolveContactCustomer") throw new Error("Unsupported QUERY operation");
				if (config["query"] !== undefined) throw new Error("QUERY operation and query are mutually exclusive");
				if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(config["storeAs"]) ||
					["__proto__", "prototype", "constructor", "contact", "message", "logger", "instance", "sectorId", "customer", "legacyCampaignType", "legacySchedule"].includes(config["storeAs"]))
					throw new Error("Invalid QUERY operation storeAs");
			} else if (typeof config["query"] !== "string" || !config["query"].trim()) throw new Error("QUERY requires query or operation");
		}
	});

	StepRegistry.register("ROUTER", RouterStep, {
		description: "Roteia baseado no valor de um campo",
		requiredConfig: ["field"],
		optionalConfig: []
	});

	StepRegistry.register("ASSIGN", AssignStep, {
		description: "Atribui o chat a um usuário, carteira ou admin",
		requiredConfig: [],
		optionalConfig: ["userId", "walletId", "priority", "systemMessage", "type", "validateUser", "fallbackUserId", "fallbackRequireAdmin", "decisionReason"],
		validateConfig: (config) => {
			if (config["validateUser"] !== undefined && typeof config["validateUser"] !== "boolean") throw new Error("ASSIGN validateUser must be boolean");
			if (config["validateUser"] === true) {
				if (!Number.isSafeInteger(config["userId"]) || config["userId"] <= 0 ||
					!Number.isSafeInteger(config["fallbackUserId"]) || config["fallbackUserId"] <= 0 || config["userId"] === config["fallbackUserId"])
					throw new Error("Validated ASSIGN requires distinct positive userId and fallbackUserId");
				if (config["walletId"] != null) throw new Error("Validated ASSIGN does not accept walletId");
				if (config["fallbackRequireAdmin"] !== undefined && typeof config["fallbackRequireAdmin"] !== "boolean") throw new Error("ASSIGN fallbackRequireAdmin must be boolean");
			}
		}
	});

	// ===== BUSINESS STEPS (Específicos - Compatibilidade) =====

	StepRegistry.register("CHECK_ONLY_ADMIN", CheckOnlyAdminStep, {
		description: "Verifica se o contato é apenas admin",
		requiredConfig: [],
		optionalConfig: []
	});

	StepRegistry.register("CHECK_LOALTY", CheckLoyaltyStep, {
		description: "Verifica fidelização do cliente e tenta atribuir ao operador fidelizado",
		requiredConfig: [],
		optionalConfig: ["checkIsOnline", "checkIsActive", "checkIsRepresentative"]
	});

	StepRegistry.register("CHECK_AVAILABLE_USERS", CheckAvailableUsersStep, {
		description: "Distribui para usuário com menos chats ativos",
		requiredConfig: [],
		optionalConfig: []
	});

	StepRegistry.register("CHECK_USER_ONLINE", CheckUserOnlineStep, {
		description: "Verifica se um usuário específico está online buscando o ID do contexto",
		requiredConfig: ["userIdField"],
		optionalConfig: []
	});

	StepRegistry.register("SEND_TO_ADMIN", SendToAdminStep, {
		description: "Envia chat para admin/supervisor (userId = -1)",
		requiredConfig: [],
		optionalConfig: ["systemMessage"]
	});

	StepRegistry.register("SEND_TO_SECTOR_USER", SendToSectorUserStep, {
		description: "Envia chat para usuário específico do setor (prioriza admin)",
		requiredConfig: [],
		optionalConfig: ["preferAdmin", "systemMessage"]
	});

	StepRegistry.register("AI_AGENT", AiAgentStep, {
		description: "Aciona agente de IA para processar a mensagem",
		requiredConfig: [],
		optionalConfig: ["agentId"]
	});
}
