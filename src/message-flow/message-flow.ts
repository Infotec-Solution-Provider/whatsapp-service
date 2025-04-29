import ProcessingLogger from "../utils/processing-logger";
import Step, { ChatPayload, StepContext } from "./steps/step";
import { WppContact } from "@prisma/client";

export default class MessageFlow {
	private steps: Map<number, Step> = new Map();

	// Fluxos ativos por ContactId;
	private activeFlows: Map<number, Promise<ChatPayload>> = new Map();

	public async getChatPayload(
		logger: ProcessingLogger,
		contact: WppContact
	): Promise<ChatPayload> {
		logger.log("Iniciando o processamento da mensagem no fluxo de etapas.");

		// Verifique se já existe um fluxo ativo para o contato
		if (this.activeFlows.has(contact.id)) {
			logger.log(
				`Já existe um fluxo ativo para o contato ${contact.id}. Aguardando...`
			);
			return this.activeFlows.get(contact.id)!; // Retorna o fluxo ativo
		}

		// Crie um novo fluxo e armazene no mapa de controle
		const flowPromise = this.processFlow(logger, contact);
		this.activeFlows.set(contact.id, flowPromise);

		try {
			const chat = await flowPromise;
			return chat;
		} finally {
			// Remova o fluxo do mapa após a conclusão
			this.activeFlows.delete(contact.id);
		}
	}

	private async processFlow(
		logger: ProcessingLogger,
		contact: WppContact
	): Promise<ChatPayload> {
		let currStepId = 1;
		const context: StepContext = { logger, contact };

		while (true) {
			const step = this.getStep(currStepId, logger);
			const result = await this.executeStep(step, context);

			if (result.isFinal) {
				logger.log(
					`A etapa ${currStepId} retornou um chat com sucesso!`,
					result.chatData
				);
				return this.validateChat(result.chatData, logger);
			}

			currStepId = this.getNextStepId(result, currStepId, logger);
		}
	}

	private getStep(stepId: number, logger: ProcessingLogger): Step {
		const step = this.steps.get(stepId);
		if (!step) {
			const err = new Error(`Etapa ${stepId} não encontrada.`);
			logger.log(`Erro: ${err.message}`);
			logger.failed(err);
			throw err;
		}
		return step;
	}

	private async executeStep(
		step: Step,
		context: {
			logger: ProcessingLogger;
			contact: WppContact;
		}
	) {
		context.logger.log(`Executando a lógica da etapa ${step.id}.`);
		return step.run(context);
	}

	private validateChat(
		chat: ChatPayload | null,
		logger: ProcessingLogger
	): ChatPayload {
		if (!chat) {
			const err = new Error(
				"Nenhum chat foi retornado pelo fluxo de etapas."
			);
			logger.log("Erro: Falha ao gerar um chat.");
			logger.failed(err);
			throw err;
		}
		logger.log("Processamento do fluxo de etapas concluído com sucesso.");
		return chat;
	}

	private getNextStepId(
		result: { stepId?: number; isFinal: boolean },
		currStepId: number,
		logger: ProcessingLogger
	): number {
		if (result.stepId) {
			logger.log(
				`A etapa ${currStepId} direcionou para a próxima etapa ${result.stepId}.`
			);
			return result.stepId;
		}

		const err = new Error(
			`A etapa ${currStepId} não retornou um próximo passo nem um resultado final.`
		);
		logger.log(`Erro: ${err.message}`);
		logger.failed(err);
		throw err;
	}

	public addStep(step: Step): void {
		this.steps.set(step.id, step);
	}
}
