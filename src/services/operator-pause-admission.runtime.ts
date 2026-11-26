import walletsService from "./wallets.service";
import prismaService from "./prisma.service";
import { tenantSqlEnabled } from "../tenant-sql/registry";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { operatorPauseAdmission } from "./operator-pause-admission";
import type { SessionData } from "../sdk-local";

export async function pauseEligibleOperatorIds(instance: string, ids: number[]): Promise<Set<number>> {
	if (!tenantSqlEnabled()) return new Set(ids);
	return withDatabaseTenant(instance, () => prismaService.$transaction(tx =>
		operatorPauseAdmission.eligible(tx, instance, ids, true)));
}

export async function admitHumanSend(session: Pick<SessionData, "instance" | "userId">, chatId?: unknown, contactId?: unknown, to?: unknown): Promise<void> {
	if (session.userId <= 0) return;
	const id = (value: unknown) => {
		const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
		return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
	};
	const targetId = id(chatId);
	if (targetId) {
		const chat = await prismaService.wppChat.findFirst({ where: { instance: session.instance, id: targetId }, select: { userId: true, walletId: true } });
		if (chat) await walletsService.assertChatMember(session, chat);
	} else if (id(contactId)) {
		const chats = await prismaService.wppChat.findMany({ where: { instance: session.instance, contactId: id(contactId), isFinished: false, walletId: { not: null } },
			select: { userId: true, walletId: true } });
		for (const chat of chats) await walletsService.assertChatMember(session, chat);
	}
	if (!tenantSqlEnabled()) return;
	return withDatabaseTenant(session.instance, () => prismaService.$transaction(tx => operatorPauseAdmission.assertSend(tx, {
		instance: session.instance, actorId: session.userId, chatId: id(chatId), contactId: id(contactId), to
	}, true)));
}
