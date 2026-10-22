import { Prisma } from "@prisma/client";
import type { SessionData } from "../../sdk-local";
import prismaService from "../prisma.service";
import chatsService from "../chats.service";
import messagePresentationService from "../message-presentation.service";
import type { ChangeRepository, JournalRow, StreamHead } from "./session-change-reader";

export function previousChatAccess(session: SessionData, row: JournalRow, wallets: number[]): boolean {
	return row.previousUserId === session.userId ||
		(row.previousWalletId !== null && wallets.includes(row.previousWalletId)) ||
		(session.role === "ADMIN" && row.previousUserId === -1 && row.previousSectorId === session.sectorId);
}

export class SessionChangeRepository implements ChangeRepository {
	public async wallets(session: SessionData) {
		const rows = await prismaService.wppWalletUser.findMany({
			where: { userId: session.userId, WppWallet: { instance: session.instance } }, select: { walletId: true }
		});
		return rows.map((row) => row.walletId);
	}
	public async read(instance: string, after: string | null, limit: number) {
		return prismaService.$transaction(async (tx) => {
			const heads = await tx.$queryRawUnsafe<StreamHead[]>(
				`SELECT epoch, CAST(sequence AS CHAR) sequence, CAST(floor_sequence AS CHAR) floorSequence
				 FROM session_change_streams WHERE instance = ?`, instance);
			const head = heads[0] ?? { epoch: "empty", sequence: "0", floorSequence: "0" };
			const rows = after === null || limit === 0 || after === head.sequence ? [] : await tx.$queryRawUnsafe<JournalRow[]>(
				`SELECT CAST(sequence AS CHAR) sequence, kind, entity_id entityId, chat_id chatId,
				 previous_user_id previousUserId, previous_wallet_id previousWalletId, previous_sector_id previousSectorId
				 FROM session_changes WHERE instance = ? AND sequence > CAST(? AS UNSIGNED) AND sequence <= CAST(? AS UNSIGNED)
				 ORDER BY session_changes.sequence LIMIT ?`,
				instance, after, head.sequence, limit);
			return { head, rows };
		}, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
	}
	public async project(session: SessionData, rows: JournalRow[], wallets: number[]) {
		const chatIds = [...new Set(rows.flatMap((row) => row.chatId === null ? [] : [row.chatId]))];
		if (!chatIds.length) return { chats: [], messages: [], removedChatIds: [], removedMessageIds: [] };
		const { chats } = await chatsService.getUserChatsBySession(session, false, true, chatIds);
		const visible = new Set(chats.map((chat) => chat.id));
		const messageIds = [...new Set(rows.filter((row) => row.kind === "message" && visible.has(row.chatId ?? -1)).map((row) => row.entityId))];
		const messages = messageIds.length ? await prismaService.wppMessage.findMany({
			where: { instance: session.instance, id: { in: messageIds }, chatId: { in: [...visible] } }
		}) : [];
		if (session.instance === "vollo") for (const message of messages) {
			try { message.body = decodeURIComponent(message.body); } catch { /* Preserve legacy text. */ }
		}
		const found = new Set(messages.map((message) => message.id));
		return {
			chats, messages: await messagePresentationService.hydrate(session.instance, messages),
			removedChatIds: [...new Set(rows.filter((row) => row.kind === "chat" && !visible.has(row.entityId) &&
				previousChatAccess(session, row, wallets)).map((row) => row.entityId))],
			removedMessageIds: messageIds.filter((id) => !found.has(id))
		};
	}
}
