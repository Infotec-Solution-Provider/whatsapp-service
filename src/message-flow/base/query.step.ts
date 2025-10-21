import { BaseStep, StepContext, StepResult } from "./base.step";
import instancesService from "../../services/instances.service";

interface QueryConfig {
	query: string; // SQL query
	params?: any[]; // Parâmetros (suporta interpolação com ${...})
	storeAs: string; // Nome da variável para armazenar resultado
	single?: boolean; // Se true, retorna apenas primeiro resultado
	required?: boolean; // Se true e nenhum resultado, vai para fallback
}

/**
 * Step genérico para executar queries SQL e armazenar resultados no contexto.
 * Suporta interpolação de variáveis nos parâmetros.
 */
export class QueryStep extends BaseStep {
	async execute(context: StepContext): Promise<StepResult> {
		const config = this.config as QueryConfig;

		const querySummary = config.query.length > 60 
			? config.query.substring(0, 60) + '...' 
			: config.query;
		
		context.logger.log(`  Query: ${querySummary}`, {
			storeAs: config.storeAs,
			single: config.single || false,
			required: config.required || false,
			hasParams: (config.params?.length || 0) > 0
		});

		const params = config.params ? this.resolveParams(context, config.params) : [];

		if (params.length > 0) {
			context.logger.log(`  Params: ${JSON.stringify(params)}`);
		}

		const results = (await instancesService.executeQuery(
			this.instance,
			config.query,
			params
		)) as any[];

		context.logger.log(`  Resultados: ${results.length} linha(s) retornada(s)`);

		if (config.required && results.length === 0) {
			context.logger.log(`  ⚠ Query obrigatória não retornou dados → fallback`);

			if (this.fallbackStepNumber) {
				return this.continue(context, this.fallbackStepNumber);
			}

			throw new Error(`Query required but returned no results: ${config.query}`);
		}

		// Armazena resultado no contexto
		const value = config.single ? results[0] : results;
		context[config.storeAs] = value;

		context.logger.log(`  ✓ Armazenado: context.${config.storeAs} ${config.single ? '(single)' : `(array[${results.length}])`}`);

		return this.continue(context);
	}
}
