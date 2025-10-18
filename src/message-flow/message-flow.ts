import ProcessingLogger from "../utils/processing-logger";

import { WppContact } from "@prisma/client";
import { BaseStep, ChatPayload, StepContext, StepResult } from "./base/base.step";

export default class MessageFlow {
	private steps: Map<number, BaseStep> = new Map(); // Map<stepNumber, BaseStep>
	private activeFlows: Map<number, Promise<ChatPayload>> = new Map();

	public async getChatPayload(logger: ProcessingLogger, contact: WppContact): Promise<ChatPayload> {
		logger.log("Iniciando o processamento da mensagem no fluxo de etapas.");
		logger.debug(`[MessageFlow] Total de etapas registradas: ${this.steps.size}`);
		logger.debug(`[MessageFlow] Números das etapas disponíveis: [${Array.from(this.steps.keys()).join(', ')}]`);

		const ongoingFlow = this.getOngoingFlow(contact.id);
		if (ongoingFlow) {
			logger.log(`Já existe um fluxo ativo para o contato ${contact.id}. Aguardando...`);
			return ongoingFlow;
		}

		const newFlow = this.processFlow(logger, contact);
		this.activeFlows.set(contact.id, newFlow);

		try {
			const chat = await newFlow;
			return chat;
		} finally {
			this.activeFlows.delete(contact.id);
		}
	}

	private getOngoingFlow(contactId: number) {
		if (this.activeFlows.has(contactId)) {
			return this.activeFlows.get(contactId)!;
		}

		return null;
	}

	private async processFlow(logger: ProcessingLogger, contact: WppContact): Promise<ChatPayload> {
		try {
			let currentStepNumber = 1; // Começa sempre na etapa #1
			let context: StepContext = { logger, contact };
			let iterationCount = 0;

			logger.debug(`[MessageFlow] Iniciando processamento do fluxo para o contato ${contact.id}`);

			while (true) {
				iterationCount++;
				logger.debug(`[MessageFlow] Iteração ${iterationCount} - Tentando executar etapa #${currentStepNumber}`);
				
				const step = this.getStep(currentStepNumber, logger);
				logger.debug(`[MessageFlow] Etapa #${currentStepNumber} encontrada: ${step.constructor.name}`);
				
				const result = await this.executeStep(step, context);
				logger.debug(`[MessageFlow] Resultado da etapa #${currentStepNumber}:`, {
					isFinal: result.isFinal,
					nextStepNumber: result.nextStepNumber,
					hasContext: !!result.context,
					hasChatData: !!result.chatData
				});

				if (result.isFinal) {
					logger.log(`A etapa #${currentStepNumber} retornou um chat com sucesso!`, result.chatData);
					logger.debug(`[MessageFlow] Fluxo finalizado após ${iterationCount} iterações`);
					return this.validateChat(result.chatData || null, logger);
				}
				context = { ...context, ...result.context };
				currentStepNumber = this.getNextStepNumber(result, currentStepNumber);
				logger.debug(`[MessageFlow] Próxima etapa a ser executada: #${currentStepNumber}`);
			}
		} catch (error) {
			logger.log("Erro durante o processamento do fluxo de etapas:", error);
			logger.failed(error);
			throw error;
		}
	}

	private getStep(stepNumber: number, logger: ProcessingLogger): BaseStep {
		logger.debug(`[MessageFlow] Buscando etapa #${stepNumber} no mapa de etapas`);
		const step = this.steps.get(stepNumber);
		if (!step) {
			const availableSteps = Array.from(this.steps.keys()).join(', ');
			logger.debug(`[MessageFlow] Etapas disponíveis: [${availableSteps}]`);
			const err = new Error(`Etapa #${stepNumber} não encontrada no fluxo.`);
			logger.log(`Erro: ${err.message}`);
			logger.failed(err);
			throw err;
		}
		logger.debug(`[MessageFlow] Etapa #${stepNumber} encontrada: ${step.constructor.name}`);
		return step;
	}

	private async executeStep(step: BaseStep, context: StepContext) {
		context.logger.log(`Executando a lógica da etapa #${step.stepNumber}.`);
		return step.run(context);
	}

	private validateChat(chatPayload: ChatPayload | null, logger: ProcessingLogger): ChatPayload {
		if (!chatPayload) {
			throw new Error("Nenhum chat foi retornado pelo fluxo de etapas.");
		}
		logger.log("Processamento do fluxo de etapas concluído com sucesso.");
		return chatPayload;
	}

	private getNextStepNumber(result: StepResult, currentStepNumber: number): number {
		if (!result.nextStepNumber) {
			throw new Error(`A etapa #${currentStepNumber} não retornou um próximo passo nem um resultado final.`);
		}

		return result.nextStepNumber;
	}

	public addStep(step: BaseStep): void {
		if (this.steps.has(step.stepNumber)) {
			throw new Error(`Etapa #${step.stepNumber} já está registrada no fluxo de mensagens.`);
		}
		this.steps.set(step.stepNumber, step);
		console.log(`[MessageFlow] Etapa #${step.stepNumber} (${step.constructor.name}) registrada com sucesso`);
	}

	public debugStepsMap(): void {
		console.log('[MessageFlow] === Mapa de Etapas Registradas ===');
		console.log(`[MessageFlow] Total de etapas: ${this.steps.size}`);
		this.steps.forEach((step, stepNumber) => {
			console.log(`[MessageFlow] Etapa #${stepNumber} -> ${step.constructor.name}`);
		});
		console.log('[MessageFlow] ===============================');
	}
}
