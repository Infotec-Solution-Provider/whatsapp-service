import { distributionReads, FlowDistributionReads } from "../distribution-reads";
import type { UserOnlineSession } from "../../sdk-local";
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";

interface UserChatCount {
	userId: number;
	chats: number;
}

export default class CheckAvailableUsersStep extends BaseStep {
	constructor(config: StepConfig, private readonly reads: FlowDistributionReads = distributionReads) {
		super(config);
	}

	/**
	 * Obtém a contagem de chats por usuário.
	 */
	private async getUserChatsCount(
		sessions: UserOnlineSession[]
	): Promise<UserChatCount[]> {
		const userIds = sessions.map((session) => session.data.userId);

		const counts = await this.reads.chatCounts(this.instance, userIds);

		return sessions
			.map((session) => {
				const userId = session.data.userId;
				const chats = counts.get(userId) ?? 0;
				return { userId, chats };
			})
			.sort((a, b) => a.chats - b.chats);
	}

	/**
	 * Obtém as sessões online filtradas pelo setor.
	 */
	private async getSectorOnlineSessions(): Promise<UserOnlineSession[]> {
		const sessions = await this.reads.sessions(this.instance);
		const sectorSessions = sessions.filter((s) => s.data.sectorId === this.sectorId);
		const eligible = await this.reads.eligible(this.instance, sectorSessions.map(session => session.data.userId));
		return sectorSessions.filter(session => eligible.has(session.data.userId));
	}

	/**
	 * Executa o passo.
	 */
	public async execute(ctx: StepContext): Promise<StepResult> {
		ctx.logger.log("Verificando usuários disponíveis...");

		const sessions = await this.getSectorOnlineSessions();
		ctx.logger.log(`Encontradas ${sessions.length} sessões online`);

		if (sessions.length === 0) {
			ctx.logger.log("Nenhum usuário disponível encontrado.");
			return this.continue(ctx, undefined, "Nenhum operador disponível no setor.");
		}

		const usersChats = await this.getUserChatsCount(sessions);

		if (usersChats.length === 0) {
			ctx.logger.log("Nenhum usuário disponível encontrado.");
			return this.continue(ctx);
		}

		const { userId, chats } = usersChats[0]!;
		const tied = usersChats.some(other => other.userId !== userId && other.chats === chats);

		const chatData = {
			instance: this.instance,
			userId,
			sectorId: this.sectorId,
			type: "RECEPTIVE" as const,
			contactId: ctx.contact.id
		};

		ctx.logger.log(`Usuário ${userId} será atribuído ao chat.`, chatData);

		return this.finalize(chatData, tied ? "Menor carga empatada. Escolhido pela ordem das sessões consultadas." : "Operador elegível com o menor número de atendimentos abertos.");
	}
}
