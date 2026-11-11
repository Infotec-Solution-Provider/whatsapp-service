import { whatsappParameterSettings } from "../parameters/parameter-settings.catalog";
import { DEFAULT_HUMAN_BEHAVIOR_CONFIG as human } from "../utils/human-behavior.simulator";
import type { AdminSetting } from "./admin-protocol";

const scopes = ["INSTANCE", "SECTOR", "USER"];
export const parameterCatalog: AdminSetting[] = whatsappParameterSettings.map(field => ({
  key: field.key, label: field.label, description: field.description, category: field.group, type: field.type,
  defaultValue: field.type === "boolean" ? field.defaultValue === null ? null : field.defaultValue === "true" : Number(field.defaultValue),
  ...(field.min !== undefined ? { min: field.min * (field.multiplier ?? 1) } : {}),
  ...(field.max !== undefined ? { max: field.max * (field.multiplier ?? 1) } : {}),
  ...(field.multiplier ? { multiplier: field.multiplier } : {}), ...(field.unit ? { unit: field.unit } : {}),
  supportedScopes: field.supportedScopes ?? scopes, canReset: true, applyMode: "dynamic", ...(field.type === "number" ? { step: 1 } : {}),
} as AdminSetting));
function flag(key: string, label: string, category: string, defaultValue = false, supportedScopes = scopes) {
  parameterCatalog.push({ key, label, description: "Recurso controlado por parâmetro dinâmico.", category, type: "boolean", defaultValue, supportedScopes, canReset: true, applyMode: "dynamic" });
}
function number(key: string, label: string, category: string, defaultValue: number | null, min: number, max: number, supportedScopes = scopes, unit?: string) {
  parameterCatalog.push({ key, label, description: "Limite aplicado pelo consumidor deste parâmetro.", category, type: "number", defaultValue, min, max, step: key === "monitor:sla_minutes" ? 0.1 : 1, supportedScopes, canReset: true, applyMode: "dynamic", ...(unit ? { unit } : {}) });
}
flag("feature_perf_paginated_chat_history_enabled", "Histórico de conversas paginado", "Desempenho");
flag("feature_perf_stable_socket_listeners_enabled", "Listeners de socket estáveis", "Desempenho");
flag("feature_perf_virtualized_chat_list_enabled", "Lista de conversas virtualizada", "Desempenho");
flag("is_official", "Comportamento de canal oficial no frontend", "Canais");
flag("feature_legacy_history_enabled", "Histórico legado", "Histórico");
parameterCatalog.find(field => field.key === "feature_legacy_history_enabled")!.description = "Acesso à rota de histórico legado quando ela existe no frontend publicado. A rota atual restringe seu uso a administradores da Odim.";
flag("monitor:use_local_search", "Monitoria no CRM local", "Monitoria");
number("monitor:sla_minutes", "SLA de atendimento", "Monitoria", null, 0.1, 525600, scopes, "minutos");
number("customer_linking_timeout_ms", "Tempo limite da vinculação de cliente", "Contatos", null, 1000, 2147483647, ["INSTANCE", "SECTOR"], "milissegundos");
number("satisfaction_survey_timeout_ms", "Tempo limite da pesquisa de satisfação", "Satisfação", null, 1000, 2147483647, scopes, "milissegundos");
flag("human_behavior.enabled", "Simulação de comportamento humano", "Comportamento humano", human.enabled, ["INSTANCE"]);
flag("human_behavior.send_typing_state", "Enviar estado digitando", "Comportamento humano", human.sendTypingState, ["INSTANCE"]);
for (const [name, label, values, unit] of [
  ["reading_speed", "Velocidade de leitura", human.readingSpeed, "palavras/minuto"],
  ["thinking_time", "Tempo de reflexão", human.thinkingTime, "milissegundos"],
  ["typing_speed", "Velocidade de digitação", human.typingSpeed, "palavras/minuto"],
  ["typing_state_duration", "Duração do estado digitando", human.typingStateDuration, "milissegundos"],
] as const) for (const bound of ["min", "max"] as const) number(`human_behavior.${name}.${bound}`, `${label} (${bound === "min" ? "mínimo" : "máximo"})`, "Comportamento humano", values[bound], 0, 2147483647, ["INSTANCE"], unit);
for (const field of parameterCatalog) if (field.key.startsWith("human_behavior.")) field.applyMode = "reload";

export const channelCatalog: AdminSetting[] = [
  { key: "name", label: "Nome do canal", description: "Identidade do canal; a sessão WWEBJS usa este nome no armazenamento local.", category: "Canal", type: "string" },
  { key: "phone", label: "Telefone", description: "Telefone associado ao canal.", category: "Canal", type: "string" },
  { key: "type", label: "Provedor", description: "Tipo de provedor usado após reaplicar o canal.", category: "Canal", type: "enum", options: ["WABA", "GUPSHUP", "REMOTE", "WWEBJS"].map(value => ({ label: value, value })) },
  { key: "isActive", label: "Canal ativo", description: "Disponibilizar o canal após reaplicar sua configuração.", category: "Canal", type: "boolean" },
  { key: "WABAPhoneId", label: "ID do telefone WABA", description: "Identificador do telefone no WhatsApp Business.", category: "WABA", type: "string" },
  { key: "WABAAccountId", label: "ID da conta WABA", description: "Identificador da conta WhatsApp Business.", category: "WABA", type: "string" },
  { key: "WABAToken", label: "Token WABA", description: "Informe um novo token para substituí-lo.", category: "WABA", type: "secret" },
  { key: "gupshupToken", label: "Chave Gupshup", description: "Informe uma nova chave para substituí-la.", category: "Gupshup", type: "secret" },
  { key: "gupshupAppName", label: "Nome do app Gupshup", description: "Aplicação vinculada ao canal.", category: "Gupshup", type: "string" },
  { key: "gupshupAppId", label: "ID do app Gupshup", description: "Identificador da aplicação.", category: "Gupshup", type: "string" },
  { key: "remoteClientUrl", label: "URL do cliente remoto", description: "Endpoint HTTP do cliente WhatsApp remoto; URLs com credenciais são mantidas em sigilo.", category: "Remote", type: "secret" },
].map(field => ({ ...field, canReset: false, applyMode: "reload" } as AdminSetting));
