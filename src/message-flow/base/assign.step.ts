import { WppChatPriority } from "@prisma/client";
import { BaseStep, ChatPayload, StepContext, StepResult } from "./base.step";

interface AssignConfig {
	userId?: number | string; // ID do usuário (ou -1 para admin) ou campo para resolver
	walletId?: number | string; // ID da carteira ou campo para resolver
	priority?: WppChatPriority; // Prioridade do chat
	systemMessage?: string; // Mensagem do sistema
	type?: "RECEPTIVE" | "ACTIVE"; // Tipo do chat
}

/**
 * Step genérico para atribuir um chat a um usuário, carteira ou admin.
 * Suporta interpolação de variáveis (ex: userId: "${context.assignedUserId}")
 */
export class AssignStep extends BaseStep {
	async execute(context: StepContext): Promise<StepResult> {
		const config = this.config as AssignConfig;

		// Permite interpolação de variáveis
		const userId =
			typeof config.userId === "string" && config.userId.startsWith("${")
				? this.resolveField(context, config.userId.slice(2, -1))
				: config.userId;

		const walletId =
			typeof config.walletId === "string" && config.walletId.startsWith("${")
				? this.resolveField(context, config.walletId.slice(2, -1))
				: config.walletId;

		const chatData: ChatPayload = {
			instance: this.instance,
			type: config.type || "RECEPTIVE",
			sectorId: this.sectorId,
			contactId: context.contact.id,
			userId: (userId as number) ?? -1,
			walletId: (walletId as number) ?? null
		};

		if (config.systemMessage) {
			const interpolated = this.interpolateString(context, config.systemMessage);
			chatData.systemMessage = interpolated;
			context.logger.log(`System message interpolated: "${config.systemMessage}" → "${interpolated}"`);
		}
		if (config.priority) {
			chatData.priority = config.priority;
		}

		context.logger.log("Chat atribuído", chatData);

		return this.finalize(chatData);
	}
}
