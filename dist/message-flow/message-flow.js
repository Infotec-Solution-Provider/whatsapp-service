"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class MessageFlow {
    steps = new Map();
    activeFlows = new Map();
    async getChatPayload(logger, contact) {
        logger.log("Iniciando o processamento da mensagem no fluxo de etapas.");
        if (this.activeFlows.has(contact.id)) {
            logger.log(`Já existe um fluxo ativo para o contato ${contact.id}. Aguardando...`);
            return this.activeFlows.get(contact.id);
        }
        const flowPromise = this.processFlow(logger, contact);
        this.activeFlows.set(contact.id, flowPromise);
        try {
            const chat = await flowPromise;
            return chat;
        }
        finally {
            this.activeFlows.delete(contact.id);
        }
    }
    async processFlow(logger, contact) {
        let currStepId = 1;
        const context = { logger, contact };
        while (true) {
            const step = this.getStep(currStepId, logger);
            const result = await this.executeStep(step, context);
            if (result.isFinal) {
                logger.log(`A etapa ${currStepId} retornou um chat com sucesso!`, result.chatData);
                return this.validateChat(result.chatData, logger);
            }
            currStepId = this.getNextStepId(result, currStepId, logger);
        }
    }
    getStep(stepId, logger) {
        const step = this.steps.get(stepId);
        if (!step) {
            const err = new Error(`Etapa ${stepId} não encontrada.`);
            logger.log(`Erro: ${err.message}`);
            logger.failed(err);
            throw err;
        }
        return step;
    }
    async executeStep(step, context) {
        context.logger.log(`Executando a lógica da etapa ${step.id}.`);
        return step.run(context);
    }
    validateChat(chat, logger) {
        if (!chat) {
            const err = new Error("Nenhum chat foi retornado pelo fluxo de etapas.");
            logger.log("Erro: Falha ao gerar um chat.");
            logger.failed(err);
            throw err;
        }
        logger.log("Processamento do fluxo de etapas concluído com sucesso.");
        return chat;
    }
    getNextStepId(result, currStepId, logger) {
        if (result.stepId) {
            logger.log(`A etapa ${currStepId} direcionou para a próxima etapa ${result.stepId}.`);
            return result.stepId;
        }
        const err = new Error(`A etapa ${currStepId} não retornou um próximo passo nem um resultado final.`);
        logger.log(`Erro: ${err.message}`);
        logger.failed(err);
        throw err;
    }
    addStep(step) {
        this.steps.set(step.id, step);
    }
}
exports.default = MessageFlow;
