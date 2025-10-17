import { WppChatPriority, WppChatType, WppContact } from "@prisma/client";
import ProcessingLogger from "../../utils/processing-logger";
import { Customer } from "@in.pulse-crm/sdk";

export interface CustomerSchedule {
	CODIGO: number;
	CLIENTE: number;
	CAMPANHA: number;
	DT_RESULTADO: Date | null;
	DT_AGENDAMENTO: Date;
	RESULTADO: number;
	CONCLUIDO: "SIM" | "NAO";
	FONE1: string;
	FONE2: string;
	FONE3: string;
	ORDEM: number;
	OPERADOR: number;
	OPERADOR_LIGACAO: number;
	DATA_HORA_LIG: Date | null;
	TELEFONE_LIGADO: string | null;
	DATA_HORA_FIM: Date | null;
	AGENDA: number;
	DESC_FONE1: string | null;
	DESC_FONE2: string | null;
	DESC_FONE3: string | null;
	FIDELIZA: "S" | "N";
	MANUAL: "S" | "N";
}

export interface StepConfig {
	id: number;
	instance: string;
	sectorId: number;
	config?: Record<string, any>;
	nextStepId?: number;
	fallbackStepId?: number;
}

export interface StepContext {
	contact: WppContact;
	logger: ProcessingLogger;
	instance?: string;
	sectorId?: number;
	customer?: Customer | null;
	legacyCampaignType?: string | null;
	legacySchedule?: CustomerSchedule | null;
	[key: string]: any; // Permite adicionar propriedades dinâmicas
}

export interface StepResult {
	isFinal: boolean;
	stepId?: number;
	chatData?: ChatPayload;
	context: StepContext;
}

export interface ChatPayload {
	instance: string;
	type: WppChatType;
	userId?: number | null;
	walletId?: number | null;
	sectorId: number;
	contactId: number;
	systemMessage?: string;
	priority?: WppChatPriority;
}

/**
 * Classe base abstrata para todos os steps do fluxo de mensagens.
 * Fornece funcionalidades comuns como logging, resolução de campos e error handling.
 */
export abstract class BaseStep {
	public readonly id: number;
	protected readonly instance: string;
	protected readonly sectorId: number;
	protected readonly config: Record<string, any>;
	protected readonly nextStepId: number | undefined;
	protected readonly fallbackStepId: number | undefined;

	constructor(stepConfig: StepConfig) {
		this.id = stepConfig.id;
		this.instance = stepConfig.instance;
		this.sectorId = stepConfig.sectorId;
		this.config = stepConfig.config || {};
		this.nextStepId = stepConfig.nextStepId ?? undefined;
		this.fallbackStepId = stepConfig.fallbackStepId ?? undefined;
	}

	/**
	 * Método principal que cada step deve implementar.
	 * Contém a lógica específica de cada tipo de step.
	 */
	abstract execute(context: StepContext): Promise<StepResult>;

	/**
	 * Wrapper que adiciona logging e error handling ao execute.
	 * Este método é chamado pelo MessageFlow.
	 */
	async run(context: StepContext): Promise<StepResult> {
		context.logger.log(`[Step ${this.id}] Iniciando execução: ${this.constructor.name}`);

		try {
			const result = await this.execute(context);

			if (result.isFinal) {
				context.logger.log(`[Step ${this.id}] Finalizou com chat`, result.chatData);
			} else {
				context.logger.log(`[Step ${this.id}] Próximo step: ${result.stepId}`);
			}

			return result;
		} catch (error) {
			context.logger.log(`[Step ${this.id}] Erro durante execução`, error);

			if (this.fallbackStepId) {
				context.logger.log(`[Step ${this.id}] Usando fallback: ${this.fallbackStepId}`);
				return {
					isFinal: false,
					stepId: this.fallbackStepId,
					context
				};
			}

			throw error;
		}
	}

	/**
	 * Resolve um campo do contexto usando dot notation.
	 * Exemplo: "contact.customerId" ou "context.campaignType"
	 * @param context Contexto do step
	 * @param fieldPath Caminho do campo (ex: "contact.customerId")
	 * @returns Valor do campo ou undefined
	 */
	protected resolveField(context: StepContext, fieldPath: string): any {
		const parts = fieldPath.split(".");
		let value: any = context;

		for (const part of parts) {
			if (value === undefined || value === null) return undefined;
			value = value[part];
		}

		return value;
	}

	/**
	 * Resolve parâmetros com interpolação de variáveis.
	 * Exemplo: "${contact.customerId}" → valor real do customerId
	 * @param context Contexto do step
	 * @param params Array de parâmetros
	 * @returns Array com valores resolvidos
	 */
	protected resolveParams(context: StepContext, params: any[]): any[] {
		return params.map((param) => {
			if (typeof param === "string" && param.startsWith("${") && param.endsWith("}")) {
				const fieldPath = param.slice(2, -1);
				return this.resolveField(context, fieldPath);
			}
			return param;
		});
	}

	/**
	 * Cria um resultado para continuar o fluxo para o próximo step.
	 * @param context Contexto atualizado
	 * @param stepId ID do próximo step (opcional, usa nextStepId por padrão)
	 * @returns StepResult para continuar o fluxo
	 */
	protected continue(context: StepContext, stepId?: number): StepResult {
		return {
			isFinal: false,
			stepId: stepId !== undefined ? stepId : this.nextStepId!,
			context
		};
	}

	/**
	 * Cria um resultado final com os dados do chat criado.
	 * @param chatData Dados do chat a ser criado
	 * @returns StepResult final
	 */
	protected finalize(chatData: ChatPayload): StepResult {
		return {
			isFinal: true,
			chatData,
			context: {} as any // Será ignorado quando isFinal = true
		};
	}
}
