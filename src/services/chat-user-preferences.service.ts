import { BadRequestError } from "@rgranatodutra/http-errors";
import { Prisma } from "@prisma/client";
import { SessionData } from "../sdk-local";
import prismaService from "./prisma.service";

export type ChatPreferenceType = "wpp" | "internal";

type SessionScope = Pick<SessionData, "instance" | "userId" | "role" | "sectorId">;

class ChatUserPreferencesService {
	private key(type: ChatPreferenceType, chatId: number) {
		return `${type}:${chatId}`;
	}

	public async getMap(session: SessionScope, chatIds: number[], type: ChatPreferenceType) {
		if (!chatIds.length) return new Map<string, { isPinned: boolean; isMarkedUnread: boolean }>();

		const rows = await prismaService.chatUserPreference.findMany({
			where: {
				instance: session.instance,
				userId: session.userId,
				chatType: type,
				chatId: { in: chatIds }
			},
			select: { chatId: true, isPinned: true, isMarkedUnread: true }
		});

		return new Map(rows.map((row) => [this.key(type, row.chatId), row]));
	}

	private async assertAccess(session: SessionScope, type: ChatPreferenceType, chatId: number) {
		if (type === "internal") {
			const chat = await prismaService.internalChat.findFirst({
				where: {
					id: chatId,
					instance: session.instance,
					participants: { some: { userId: session.userId } }
				},
				select: { id: true }
			});
			if (!chat) throw new BadRequestError("Internal chat not found!");
			return;
		}

		const chat = await prismaService.wppChat.findFirst({
			where: {
				id: chatId,
				instance: session.instance,
				OR: [
					{ userId: session.userId },
					{ wallet: { WppWalletUser: { some: { userId: session.userId } } } },
					...(session.role === "ADMIN" ? [{ sectorId: session.sectorId, userId: -1 }] : [])
				]
			},
			select: { id: true }
		});
		if (!chat) throw new BadRequestError("Chat not found!");
	}

	public async update(
		session: SessionScope,
		type: ChatPreferenceType,
		chatId: number,
		action: "pin" | "unpin" | "read" | "unread"
	) {
		if (!Number.isInteger(chatId) || chatId <= 0) throw new BadRequestError("Chat ID is required!");
		await this.assertAccess(session, type, chatId);

		return prismaService.$transaction(async (tx) => {
			const where = {
				instance_userId_chatType_chatId: {
					instance: session.instance,
					userId: session.userId,
					chatType: type,
					chatId
				}
			};
			const current = await tx.chatUserPreference.findUnique({ where });

			if (action === "pin" && !current?.isPinned) {
				const count = await tx.chatUserPreference.count({
					where: { instance: session.instance, userId: session.userId, isPinned: true }
				});
				if (count >= 3) throw new BadRequestError("É possível fixar no máximo 3 conversas.");
			}

			const data = {
				isPinned: action === "pin" ? true : action === "unpin" ? false : (current?.isPinned ?? false),
				isMarkedUnread:
					action === "unread" ? true : action === "read" ? false : (current?.isMarkedUnread ?? false)
			};

			return tx.chatUserPreference.upsert({
				where,
				create: { ...where.instance_userId_chatType_chatId, ...data },
				update: data
			});
		}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
	}

	public async markRead(session: Pick<SessionData, "instance" | "userId">, type: ChatPreferenceType, chatId: number) {
		await prismaService.chatUserPreference.updateMany({
			where: { instance: session.instance, userId: session.userId, chatType: type, chatId },
			data: { isMarkedUnread: false }
		});
	}
}

export default new ChatUserPreferencesService();
