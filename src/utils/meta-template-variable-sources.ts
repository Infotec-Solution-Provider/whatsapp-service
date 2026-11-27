import type { TemplateVariables } from "../types/whatsapp-api.types";
import type { MetaTemplateInput } from "../services/meta-management.graph";

export type TemplateVariableSource = Exclude<keyof TemplateVariables, "bodyValues"> | "manual";

const sources = new Set<TemplateVariableSource>([
	"manual", "saudação_tempo", "cliente_razao", "cliente_cnpj", "atendente_nome",
	"atendente_nome_exibição", "contato_primeiro_nome", "contato_nome_completo"
]);

export function isTemplateVariableSources(value: unknown, count: number): value is TemplateVariableSource[] {
	return Array.isArray(value) && value.length === count && Array.from(value).every(source => sources.has(source));
}

export type MetaTemplateCreateInput = MetaTemplateInput & { variableSources?: TemplateVariableSource[] };
