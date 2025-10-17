import { BaseStep, StepContext, StepResult } from "./base.step";

interface ConditionConfig {
	field: string; // Campo a verificar (ex: "contact.isOnlyAdmin")
	operator: string; // Operador (equals, notEquals, contains, in, gt, lt, etc)
	value: any; // Valor para comparar
	onTrue: number; // StepId se condição for verdadeira
	onFalse: number; // StepId se condição for falsa
}

/**
 * Step genérico para avaliar condições e direcionar o fluxo baseado no resultado.
 * Suporta múltiplos operadores: equals, notEquals, contains, in, gt, gte, lt, lte, exists, regex, between
 */
export class ConditionStep extends BaseStep {
	async execute(context: StepContext): Promise<StepResult> {
		const config = this.config as ConditionConfig;
		const fieldValue = this.resolveField(context, config.field);

		context.logger.log(
			`Verificando condição: ${config.field} ${config.operator} ${config.value}`,
			{ fieldValue }
		);

		const result = this.evaluate(fieldValue, config.operator, config.value);
		const nextStepId = result ? config.onTrue : config.onFalse;

		context.logger.log(`Resultado da condição: ${result} → Step ${nextStepId}`);

		return this.continue(context, nextStepId);
	}

	private evaluate(fieldValue: any, operator: string, value: any): boolean {
		switch (operator) {
			case "equals":
			case "==":
				return fieldValue === value;

			case "notEquals":
			case "!=":
				return fieldValue !== value;

			case "contains":
				return Array.isArray(fieldValue)
					? fieldValue.includes(value)
					: String(fieldValue).includes(String(value));

			case "in":
				return Array.isArray(value) && value.includes(fieldValue);

			case "gt":
			case ">":
				return fieldValue > value;

			case "gte":
			case ">=":
				return fieldValue >= value;

			case "lt":
			case "<":
				return fieldValue < value;

			case "lte":
			case "<=":
				return fieldValue <= value;

			case "exists":
				return fieldValue !== undefined && fieldValue !== null;

			case "notExists":
				return fieldValue === undefined || fieldValue === null;

			case "regex":
				return new RegExp(value).test(String(fieldValue));

			case "between":
				return (
					Array.isArray(value) && fieldValue >= value[0] && fieldValue <= value[1]
				);

			default:
				throw new Error(`Operador não suportado: ${operator}`);
		}
	}
}
