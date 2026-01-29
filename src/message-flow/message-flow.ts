import ProcessingLogger from "../utils/processing-logger";

import { WppContact } from "@prisma/client";
import { BaseStep, ChatPayload, StepContext, StepResult } from "./base/base.step";

export default class MessageFlow {
	private steps: Map<number, BaseStep> = new Map(); // Map<stepNumber, BaseStep>
	private activeFlows: Map<number, Promise<ChatPayload>> = new Map();

	public async getChatPayload(logger: ProcessingLogger, contact: WppContact): Promise<ChatPayload> {
		logger.log("╔═══════════════════════════════════════════════════════════");
		logger.log("║ INICIANDO PROCESSAMENTO DE FLUXO");
		logger.log(`║ Contato: ${contact.name || contact.phone} (ID: ${contact.id})`);
		logger.log(`║ Steps disponíveis: ${this.steps.size} [${Array.from(this.steps.keys()).join(', ')}]`);
		logger.log("╚═══════════════════════════════════════════════════════════");

		const ongoingFlow = this.getOngoingFlow(contact.id);
		if (ongoingFlow) {
			logger.log(`⚠ Fluxo já em andamento para contato ${contact.id}. Aguardando conclusão...`);
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
			const maxIterations = 50; // Proteção contra loops infinitos

			while (true) {
				iterationCount++;

				if (iterationCount > maxIterations) {
					throw new Error(`Fluxo excedeu máximo de ${maxIterations} iterações. Possível loop infinito.`);
				}

				const step = this.getStep(currentStepNumber, logger);
				const result = await this.executeStep(step, context);

				if (result.isFinal) {
					logger.log("╔═══════════════════════════════════════════════════════════");
					logger.log(`║ ✓ FLUXO FINALIZADO (${iterationCount} steps executados)`);
					logger.log("╚═══════════════════════════════════════════════════════════");
					return this.validateChat(result.chatData || null, logger);
				}

				context = { ...context, ...result.context };
				currentStepNumber = this.getNextStepNumber(result, currentStepNumber);
			}
		} catch (error) {
			logger.log("╔═══════════════════════════════════════════════════════════");
			logger.log("║ ✗ ERRO NO PROCESSAMENTO DO FLUXO");
			logger.log("╚═══════════════════════════════════════════════════════════");
			logger.log("Erro:", error);
			logger.failed(error);
			throw error;
		}
	}

	private getStep(stepNumber: number, logger: ProcessingLogger): BaseStep {
		logger.log(`[MessageFlow] Buscando etapa #${stepNumber} no mapa de etapas`);
		const step = this.steps.get(stepNumber);
		if (!step) {
			const availableSteps = Array.from(this.steps.keys()).join(', ');
			logger.log(`[MessageFlow] Etapas disponíveis: [${availableSteps}]`);
			const err = new Error(`Etapa #${stepNumber} não encontrada no fluxo.`);
			logger.log(`Erro: ${err.message}`);
			logger.failed(err);
			throw err;
		}
		logger.log(`[MessageFlow] Etapa #${stepNumber} encontrada: ${step.constructor.name}`);
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
