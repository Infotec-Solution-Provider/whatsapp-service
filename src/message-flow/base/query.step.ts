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

		context.logger.log(`Executando query`, {
			query: config.query,
			storeAs: config.storeAs
		});

		const params = config.params ? this.resolveParams(context, config.params) : [];

		const results = (await instancesService.executeQuery(
			this.instance,
			config.query,
			params
		)) as any[];

		context.logger.log(`Query retornou ${results.length} resultado(s)`);

		if (config.required && results.length === 0) {
			context.logger.log("Query não retornou resultados (required=true)");

			if (this.fallbackStepNumber) {
				return this.continue(context, this.fallbackStepNumber);
			}

			throw new Error(`Query required but returned no results: ${config.query}`);
		}

		// Armazena resultado no contexto
		const value = config.single ? results[0] : results;
		context[config.storeAs] = value;

		context.logger.log(`Resultado armazenado em context.${config.storeAs}`);

		return this.continue(context);
	}
}
