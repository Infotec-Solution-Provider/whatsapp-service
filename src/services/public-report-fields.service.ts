import { WppChat, WppMessage } from "@prisma/client";
import operatorPerformanceService from "./operator-performance.service";
import prismaService from "./prisma.service";
import { getReportMessageType, ReportMessageType, SYSTEM_OPERATOR_ID } from "../utils/report-rules";

type ReportMessageSource = Pick<WppMessage, "from" | "to" | "userId" | "chatId">;
type ReportConversationSource = Pick<WppChat, "userId" | "finishedBy" | "isFinished" | "startedAt" | "finishedAt">;

export interface MessageReportFields {
	/** A mensagem entra no total "Mensagens" dos relatórios. */
	counted: boolean;
	type: ReportMessageType | null;
	/** Operador a quem os relatórios atribuem a mensagem (-1 = Sistema/Admin). */
	userId: number | null;
}

export interface ConversationReportFields {
	/** Responsável pela regra dos relatórios (-1 = Sistema/Admin, null = fora dos relatórios). */
	userId: number | null;
	/** A conversa entra em "Finalizados" (o período é o do finishedAt). */
	finishedCounted: boolean;
	finishedByUserId: number | null;
	/** Duração usada no "Ciclo do atendimento". */
	cycleSeconds: number | null;
}

/**
 * Campo `report` das rotas BI: aplica aos registros brutos as mesmas regras dos
 * relatórios do painel, para que a soma feita pelo cliente bata com o painel.
 */
class PublicReportFieldsService {
	public async withMessageReport<T extends ReportMessageSource>(instance: string, messages: T[]) {
		const chatIds = Array.from(
			new Set(
				messages
					.filter((message) => message.userId === null && message.chatId !== null)
					.map((message) => message.chatId as number)
			)
		);
		const chats = chatIds.length
			? await prismaService.wppChat.findMany({
					where: { instance, id: { in: chatIds } },
					select: { id: true, userId: true }
				})
			: [];
		const chatOwners = new Map(chats.map((chat) => [chat.id, chat.userId]));
		const responsibleOf = (message: T) =>
			message.userId ?? (message.chatId === null ? null : chatOwners.get(message.chatId) ?? null);

		const resolve = await operatorPerformanceService.createReportUserResolver(
			instance,
			messages.map(responsibleOf)
		);

		return messages.map((message) => {
			const type = getReportMessageType(message);
			const userId = resolve(responsibleOf(message));
			const counted = type !== null && userId !== null;
			const report: MessageReportFields = {
				counted,
				type: counted ? type : null,
				userId: counted ? userId : null
			};
			return { ...message, report };
		});
	}

	public async withConversationReport<T extends ReportConversationSource>(instance: string, conversations: T[]) {
		// Finalização sem autor (bots, rotinas) conta para Sistema/Admin, como no painel.
		const finishedByOf = (conversation: T) => conversation.finishedBy ?? SYSTEM_OPERATOR_ID;
		const resolve = await operatorPerformanceService.createReportUserResolver(
			instance,
			conversations.flatMap((conversation) => [conversation.userId, finishedByOf(conversation)])
		);

		return conversations.map((conversation) => {
			const isFinished = conversation.isFinished && conversation.startedAt !== null && conversation.finishedAt !== null;
			const finishedByUserId = isFinished ? resolve(finishedByOf(conversation)) : null;
			const finishedCounted = finishedByUserId !== null;
			const report: ConversationReportFields = {
				userId: resolve(conversation.userId),
				finishedCounted,
				finishedByUserId,
				cycleSeconds: finishedCounted
					? Math.floor((conversation.finishedAt!.getTime() - conversation.startedAt!.getTime()) / 1000)
					: null
			};
			return { ...conversation, report };
		});
	}
}

export default new PublicReportFieldsService();
