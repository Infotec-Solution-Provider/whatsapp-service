import { UserOnlineSession } from "@in.pulse-crm/sdk";
import authService from "../../services/auth.service";
import prismaService from "../../services/prisma.service";
import Step, { FinalStep, NextStep, StepContext } from "./step";

interface CheckAvailableUsersStepOptions {
	instance: string;
	sectorId: number;
	stepId: number;
	nextStepId: number;
}

interface UserChatCount {
	userId: number;
	chats: number;
}

export default class CheckAvailableUsersStep implements Step {
	private readonly instance: string;
	private readonly sectorId: number;
	private readonly nextStepId: number;
	public readonly id: number;

	constructor({
		instance,
		sectorId,
		stepId,
		nextStepId
	}: CheckAvailableUsersStepOptions) {
		this.instance = instance;
		this.sectorId = sectorId;
		this.id = stepId;
		this.nextStepId = nextStepId;
	}

	/**
	 * Obtém a contagem de chats por usuário.
	 */
	private async getUserChatsCount(
		sessions: UserOnlineSession[]
	): Promise<UserChatCount[]> {
		const userIds = sessions.map((session) => session.data.userId);

		const usersChats = await prismaService.wppChat.groupBy({
			by: ["userId"],
			where: {
				userId: { in: userIds },
				isFinished: false,
				instance: this.instance
			},
			_count: { id: true },
			orderBy: { _count: { id: "asc" } }
		});

		return sessions
			.map((session) => {
				const userId = session.data.userId;
				const chats =
					usersChats.find((uc) => uc.userId === userId)?._count.id ||
					0;
				return { userId, chats };
			})
			.sort((a, b) => a.chats - b.chats);
	}

	/**
	 * Obtém as sessões online filtradas pelo setor.
	 */
	private async getSectorOnlineSessions(): Promise<UserOnlineSession[]> {
		const sessions = await authService.getOnlineSessions(this.instance);
		return sessions.filter((s) => s.data.sectorId === this.sectorId);
	}

	/**
	 * Executa o passo.
	 */
	public async run(ctx: StepContext): Promise<NextStep | FinalStep> {
		ctx.logger.log("Verificando usuários disponíveis...");

		const sessions = await this.getSectorOnlineSessions();
		ctx.logger.log(`Encontradas ${sessions.length} sessões online`);

		if (sessions.length === 0) {
			ctx.logger.log("Nenhum usuário disponível encontrado.");
			return { isFinal: false, stepId: this.nextStepId };
		}

		const usersChats = await this.getUserChatsCount(sessions);

		if (usersChats.length === 0) {
			ctx.logger.log("Nenhum usuário disponível encontrado.");
			return { isFinal: false, stepId: this.nextStepId };
		}

		const { userId } = usersChats[0]!;

		const chatData = {
			instance: this.instance,
			userId,
			sectorId: this.sectorId,
			type: "RECEPTIVE",
			contactId: ctx.contact.id
		};

		ctx.logger.log(`Usuário ${userId} será atribuído ao chat.`, chatData);

		return {
			isFinal: true,
			chatData
		};
	}
}
