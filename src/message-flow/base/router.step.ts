import { BaseStep, StepContext, StepResult } from "./base.step";

interface RouterConfig {
	field: string; // Campo para avaliar
	routes: Record<string, number>; // Mapa valor → stepId
	default?: number; // Step padrão se não encontrar rota
}

/**
 * Step genérico para rotear o fluxo baseado no valor de um campo.
 * Útil para criar fluxos com múltiplas ramificações.
 */
export class RouterStep extends BaseStep {
	async execute(context: StepContext): Promise<StepResult> {
		const config = this.config as RouterConfig;
		const value = this.resolveField(context, config.field);

		context.logger.log(`Roteando baseado em ${config.field}`, { value });

		// Procura rota exata
		let nextStepId = config.routes[String(value)];

		// Se não encontrou, usa rota padrão
		if (nextStepId === undefined) {
			nextStepId = config.default || this.nextStepId;
		}

		if (nextStepId === undefined) {
			throw new Error(
				`Nenhuma rota encontrada para valor "${value}" e sem rota padrão`
			);
		}

		context.logger.log(`Rota selecionada: ${nextStepId}`);

		return this.continue(context, nextStepId);
	}
}
