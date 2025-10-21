import { BaseStep, StepContext, StepResult } from "./base.step";

interface RouterConfig {
	field: string; // Campo para avaliar
}

interface RouterConnections {
	routes?: Record<string, number>; // Mapa valor → stepNumber
	defaultRoute?: number; // Step padrão se não encontrar rota
}

/**
 * Step genérico para rotear o fluxo baseado no valor de um campo.
 * Útil para criar fluxos com múltiplas ramificações.
 */
export class RouterStep extends BaseStep {
	async execute(context: StepContext): Promise<StepResult> {
		const config = this.config as RouterConfig;
		const connections = this.connections as RouterConnections;
		const value = this.resolveField(context, config.field);

		const availableRoutes = Object.keys(connections.routes || {}).join(', ');
		context.logger.log(`  Roteando campo: ${config.field} = ${JSON.stringify(value)}`, {
			availableRoutes: availableRoutes || '(nenhuma)',
			hasDefault: !!connections.defaultRoute
		});

		// Procura rota exata
		let nextStepNumber = connections.routes?.[String(value)];

		// Se não encontrou, usa rota padrão
		if (nextStepNumber === undefined) {
			nextStepNumber = connections.defaultRoute || this.nextStepNumber;
			context.logger.log(`  Rota não encontrada, usando: ${connections.defaultRoute ? 'default' : 'nextStep'} → #${nextStepNumber}`);
		} else {
			context.logger.log(`  Rota encontrada: "${value}" → Step #${nextStepNumber}`);
		}

		if (nextStepNumber === undefined) {
			throw new Error(
				`Nenhuma rota encontrada para valor "${value}" e sem rota padrão`
			);
		}

		return this.continue(context, nextStepNumber);
	}
}
