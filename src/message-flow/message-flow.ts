import ProcessingLogger from "../utils/processing-logger";

import { WppContact } from "@prisma/client";
import { BaseStep, ChatPayload, StepContext, StepResult } from "./base/base.step";

export default class MessageFlow {
	private steps: Map<number, BaseStep> = new Map();
	private activeFlows: Map<number, Promise<ChatPayload>> = new Map();

	public async getChatPayload(logger: ProcessingLogger, contact: WppContact): Promise<ChatPayload> {
		logger.log("Iniciando o processamento da mensagem no fluxo de etapas.");

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
			let currStepId = 1;
			let context: StepContext = { logger, contact };

			while (true) {
				const step = this.getStep(currStepId, logger);
				const result = await this.executeStep(step, context);

				if (result.isFinal) {
					logger.log(`A etapa ${currStepId} retornou um chat com sucesso!`, result.chatData);
					return this.validateChat(result.chatData || null, logger);
				}
				context = { ...context, ...result.context };
				currStepId = this.getNextStepId(result, currStepId);
			}
		} catch (error) {
			logger.log("Erro durante o processamento do fluxo de etapas:", error);
			logger.failed(error);
			throw error;
		}
	}

	private getStep(stepId: number, logger: ProcessingLogger): BaseStep {
		const step = this.steps.get(stepId);
		if (!step) {
			const err = new Error(`Etapa ${stepId} não encontrada.`);
			logger.log(`Erro: ${err.message}`);
			logger.failed(err);
			throw err;
		}
		return step;
	}

	private async executeStep(step: BaseStep, context: StepContext) {
		context.logger.log(`Executando a lógica da etapa ${step.id}.`);
		return step.run(context);
	}

	private validateChat(chatPayload: ChatPayload | null, logger: ProcessingLogger): ChatPayload {
		if (!chatPayload) {
			throw new Error("Nenhum chat foi retornado pelo fluxo de etapas.");
		}
		logger.log("Processamento do fluxo de etapas concluído com sucesso.");
		return chatPayload;
	}

	private getNextStepId(result: StepResult, currStepId: number): number {
		if (!result.stepId) {
			throw new Error(`A etapa ${currStepId} não retornou um próximo passo nem um resultado final.`);
		}

		return result.stepId;
	}

	public addStep(step: BaseStep): void {
		if (this.steps.has(step.id)) {
			throw new Error(`Etapa com ID ${step.id} já está registrada no fluxo de mensagens.`);
		}
		this.steps.set(step.id, step);
	}
}
