import ProcessingLogger from "../processing-logger";
import Step, { StepContext } from "./steps/step";
import { WppChat, WppContact, WppMessage } from "@prisma/client";

export default class MessageFlow {
	private steps: Map<number, Step> = new Map();

	public async getChat(
		logger: ProcessingLogger,
		message: WppMessage,
		contact: WppContact
	): Promise<WppChat> {
		logger.log("Iniciando o processamento da mensagem no fluxo de etapas.");
		let currStepId = 1;

		const context: StepContext = { logger, contact, message };

		while (true) {
			const step = this.getStep(currStepId, logger);
			const result = await this.executeStep(step, context);

			if (result.isFinal) {
				logger.log(
					`A etapa ${currStepId} retornou um chat com sucesso!`,
					result.chat
				);
				return this.validateChat(result.chat, logger);
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
			message: WppMessage;
		}
	) {
		context.logger.log(`Executando a lógica da etapa ${step.id}.`);
		return step.run(context);
	}

	private validateChat(
		chat: WppChat | null,
		logger: ProcessingLogger
	): WppChat {
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
