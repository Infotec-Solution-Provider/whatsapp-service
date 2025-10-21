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
import SendToAdminStep from "./steps/send-to-admin.step";
import SendToSectorUserStep from "./steps/send-to-sector-user.step";

/**
 * Registra todos os steps disponíveis no sistema.
 * Este arquivo é carregado automaticamente ao iniciar a aplicação.
 */
export function registerAllSteps(): void {
	// ===== BASE STEPS (Genéricos) =====

	StepRegistry.register("CONDITION", ConditionStep, {
		description: "Avalia uma condição e direciona baseado no resultado",
		requiredConfig: ["field", "operator", "value"],
		optionalConfig: []
	});

	StepRegistry.register("QUERY", QueryStep, {
		description: "Executa uma query SQL e armazena resultado no contexto",
		requiredConfig: ["query", "storeAs"],
		optionalConfig: ["params", "single", "required"]
	});

	StepRegistry.register("ROUTER", RouterStep, {
		description: "Roteia baseado no valor de um campo",
		requiredConfig: ["field"],
		optionalConfig: []
	});

	StepRegistry.register("ASSIGN", AssignStep, {
		description: "Atribui o chat a um usuário, carteira ou admin",
		requiredConfig: [],
		optionalConfig: ["userId", "walletId", "priority", "systemMessage", "type"]
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
}
