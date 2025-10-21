import { WppChatPriority, WppChatType, WppContact } from "@prisma/client";
import ProcessingLogger from "../../utils/processing-logger";
import { Customer } from "@in.pulse-crm/sdk";
import { Logger } from "@in.pulse-crm/utils";

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
	stepNumber: number; // Posição sequencial no fluxo (1, 2, 3...)
	instance: string;
	sectorId: number;
	config?: Record<string, any>;
	connections?: Record<string, any>; // Conexões condicionais (onTrue/onFalse para CONDITION, routes para ROUTER)
	nextStepNumber?: number; // Próxima posição no fluxo
	fallbackStepNumber?: number; // Posição alternativa em caso de erro
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
	nextStepNumber?: number; // Próxima posição no fluxo (renomeado de stepId)
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
	public readonly stepNumber: number; // Posição sequencial no fluxo
	protected readonly instance: string;
	protected readonly sectorId: number;
	protected readonly config: Record<string, any>;
	protected readonly connections: Record<string, any>; // Conexões condicionais
	protected readonly nextStepNumber: number | undefined;
	protected readonly fallbackStepNumber: number | undefined;

	constructor(stepConfig: StepConfig) {
		this.stepNumber = stepConfig.stepNumber;
		this.instance = stepConfig.instance;
		this.sectorId = stepConfig.sectorId;
		this.config = stepConfig.config || {};
		this.connections = stepConfig.connections || {};
		this.nextStepNumber = stepConfig.nextStepNumber ?? undefined;
		this.fallbackStepNumber = stepConfig.fallbackStepNumber ?? undefined;
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
		const stepType = this.constructor.name.replace('Step', '');
		const startTime = Date.now();
		
		context.logger.log(`┌─ [Step #${this.stepNumber}] ${stepType}`, {
			instance: this.instance,
			sectorId: this.sectorId,
			contactId: context.contact?.id,
			hasConfig: Object.keys(this.config).length > 0,
			hasConnections: Object.keys(this.connections).length > 0
		});

		try {
			const result = await this.execute(context);
			const duration = Date.now() - startTime;

			if (result.isFinal) {
				context.logger.log(`└─ [Step #${this.stepNumber}] ✓ FINALIZADO (${duration}ms)`, {
					chatType: result.chatData?.type,
					userId: result.chatData?.userId,
					walletId: result.chatData?.walletId,
					priority: result.chatData?.priority,
					systemMessage: result.chatData?.systemMessage?.substring(0, 50)
				});
			} else {
				context.logger.log(`└─ [Step #${this.stepNumber}] → Step #${result.nextStepNumber} (${duration}ms)`);
			}

			return result;
		} catch (error) {
			const duration = Date.now() - startTime;
			context.logger.log(`└─ [Step #${this.stepNumber}] ✗ ERRO (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3) : undefined
			});

			if (this.fallbackStepNumber) {
				context.logger.log(`   ↳ Usando fallback → Step #${this.fallbackStepNumber}`);
				return {
					isFinal: false,
					nextStepNumber: this.fallbackStepNumber,
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
	 * Interpola uma string substituindo todas as ocorrências de ${field.path}.
	 * Exemplo: "Cliente: ${customer.NOME} (${customer.CODIGO})" → "Cliente: João (123)"
	 * @param context Contexto do step
	 * @param template String com placeholders ${...}
	 * @returns String interpolada
	 */
	protected interpolateString(context: StepContext, template: string): string {
		Logger.debug(`[BaseStep] Interpolating string: ${template}`, context);
		return template.replace(/\$\{([^}]+)\}/g, (match, fieldPath) => {
			const value = this.resolveField(context, fieldPath.trim());
			return value !== undefined && value !== null ? String(value) : match;
		});
	}

	/**
	 * Cria um resultado para continuar o fluxo para o próximo step.
	 * @param context Contexto atualizado
	 * @param nextStepNumber Número do próximo step (opcional, usa nextStepNumber por padrão)
	 * @returns StepResult para continuar o fluxo
	 */
	protected continue(context: StepContext, nextStepNumber?: number): StepResult {
		return {
			isFinal: false,
			nextStepNumber: nextStepNumber !== undefined ? nextStepNumber : this.nextStepNumber!,
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
