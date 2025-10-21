import { BaseStep, StepConfig } from "./base/base.step";

type StepConstructor = new (config: StepConfig) => BaseStep;

export interface StepMetadata {
	type: string;
	constructor: StepConstructor;
	description?: string;
	requiredConfig?: string[];
	optionalConfig?: string[];
}

/**
 * Registro centralizado de todos os tipos de steps disponíveis.
 * Permite adicionar novos steps dinamicamente sem modificar o código base.
 */
export class StepRegistry {
	private static steps = new Map<string, StepMetadata>();

	/**
	 * Registra um novo tipo de step.
	 * @param type Nome único do tipo de step
	 * @param constructor Classe construtora do step
	 * @param metadata Metadados opcionais (descrição, configs requeridas, etc)
	 */
	static register(
		type: string,
		constructor: StepConstructor,
		metadata?: Partial<Omit<StepMetadata, "type" | "constructor">>
	): void {
		this.steps.set(type, {
			type,
			constructor,
			...metadata
		});
	}

	/**
	 * Cria uma instância de step baseado no tipo.
	 * @param type Tipo do step
	 * @param config Configuração do step
	 * @returns Instância do step
	 * @throws Error se o tipo não estiver registrado ou se faltar configuração obrigatória
	 */
	static create(type: string, config: StepConfig): BaseStep {
		const metadata = this.steps.get(type);

		if (!metadata) {
			throw new Error(`Step type não registrado: ${type}`);
		}

		// Valida configuração obrigatória
		if (metadata.requiredConfig) {
			for (const key of metadata.requiredConfig) {
				if (!(key in (config.config || {}))) {
					throw new Error(`Step ${type} requer configuração: ${key}`);
				}
			}
		}

		return new metadata.constructor(config);
	}

	/**
	 * Lista todos os tipos de steps disponíveis.
	 * @returns Array com metadados de todos os steps registrados
	 */
	static getAvailableTypes(): StepMetadata[] {
		return Array.from(this.steps.values());
	}

	/**
	 * Obtém metadados de um tipo de step específico.
	 * @param type Tipo do step
	 * @returns Metadados do step ou undefined se não encontrado
	 */
	static getMetadata(type: string): StepMetadata | undefined {
		return this.steps.get(type);
	}

	/**
	 * Verifica se um tipo de step está registrado.
	 * @param type Tipo do step
	 * @returns true se o step está registrado
	 */
	static has(type: string): boolean {
		return this.steps.has(type);
	}

	/**
	 * Remove um tipo de step do registro (útil para testes).
	 * @param type Tipo do step
	 */
	static unregister(type: string): void {
		this.steps.delete(type);
	}

	/**
	 * Limpa todos os steps registrados (útil para testes).
	 */
	static clear(): void {
		this.steps.clear();
	}
}
