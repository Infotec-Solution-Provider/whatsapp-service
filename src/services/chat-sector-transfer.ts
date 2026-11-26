import walletsService from "./wallets.service";
import type { Prisma } from "@prisma/client";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local";
import db from "./prisma.service";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { latestTriageInbound } from "../triage/trigger-start";
import { enqueueTriageNotice } from "../triage/trigger-notices";
import parametersService from "./parameters.service";
import { requireFeature } from "../triage/access";

/** Homolog and Odim distributions can supply the same server policy used to build session capabilities. */
export function isTransferAllowedByTenant(session: SessionData, targetUserId?: number) {
	let path: string;
	try {
		path = require.resolve("../tenant-policies/odim.policy");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return true;
		throw error;
	}
	const policy = require(path) as {
		odimSessionCapabilities(session: SessionData): { canTransferAttendance: boolean; canUseAdminTransferTarget: boolean; excludedOperatorIds: number[] } | null;
	};
	const capabilities = policy.odimSessionCapabilities(session);
	return !capabilities || (capabilities.canTransferAttendance &&
		(targetUserId === undefined || (!capabilities.excludedOperatorIds.includes(targetUserId) &&
			(targetUserId !== -1 || capabilities.canUseAdminTransferTarget))));
}
async function transferScope(tx: Prisma.TransactionClient, session: SessionData, chatId: number, write: boolean) {
	await requireFeature(tx, session);
	if (!isTransferAllowedByTenant(session)) throw new UnauthorizedError("Seu perfil não permite transferir atendimentos.");
	if (write)
		await tx.$queryRawUnsafe("SELECT id FROM chats WHERE instance=? AND id=? FOR UPDATE", session.instance, chatId);
	const chat = await tx.wppChat.findFirst({ where: { instance: session.instance, id: chatId, isFinished: false } });
	if (chat) await walletsService.assertChatMember(session, chat);
	if (
		!chat ||
		!chat.sectorId ||
		!(
			chat.walletId || session.role === "ADMIN" ||
			(session.role === "SUPERVISOR" && session.sectorId === chat.sectorId) ||
			(chat.userId === session.userId && session.userId > 0) ||
			(await parametersService.canTransferFromContactSearch(session.instance, session.userId))
		)
	)
		throw new NotFoundError("Atendimento indisponível.");
	if (chat.botId != null || chat.agentId != null)
		throw new ConflictError("Assuma o atendimento antes de transferir o setor.");
	const source = await latestTriageInbound(tx, session.instance, chat.id);
	if (!source?.clientId) return { chat, sectors: [] };
	const sectors = await tx.$queryRawUnsafe<{ id: number; name: string }[]>(
		"SELECT s.id,s.name FROM clients c JOIN _sector_clients a ON a.A=c.id JOIN sectors s ON s.id=a.B AND s.instance=? " +
			"WHERE c.instance=? AND c.id=? AND c.is_active=1 AND s.receive_chats=1 AND s.id<>? " +
			"AND EXISTS (SELECT 1 FROM _sector_clients orig WHERE orig.A=c.id AND orig.B=?) ORDER BY s.name,s.id" +
			(write ? " FOR UPDATE" : ""),
		session.instance,
		session.instance,
		source.clientId,
		chat.sectorId,
		chat.sectorId
	);
	return { chat, sectors };
}
export function listChatTransferSectors(session: SessionData, chatId: number) {
	return withDatabaseTenant(session.instance, () =>
		db.$transaction(async (tx) => (await transferScope(tx, session, chatId, false)).sectors)
	);
}
export function transferChatToSectorQueue(session: SessionData, chatId: number, sectorId: number) {
	return withDatabaseTenant(session.instance, () =>
		db.$transaction(
			async (tx) => {
				const { chat, sectors } = await transferScope(tx, session, chatId, true);
				const target = sectors.find((s) => s.id === sectorId);
				if (!target) throw new BadRequestError("O setor de destino precisa receber atendimentos neste número.");
				const updated = await tx.wppChat.update({
					where: { id: chat.id, instance: chat.instance },
					data: { sectorId, userId: -1, walletId: null }
				});
				await tx.wppChatTransferHistory.create({
					data: {
						instance: chat.instance,
						chatId,
						fromSectorId: chat.sectorId,
						toSectorId: sectorId,
						fromUserId: chat.userId,
						toUserId: -1,
						initiatedByUserId: session.userId,
						source: "manual",
						reason: "Transferência para a fila do setor"
					}
				});
				await enqueueTriageNotice(tx, updated, "transfer");
				return {
					chat: updated,
					previousSectorId: chat.sectorId!,
					previousUserId: chat.userId,
					previousWalletId: chat.walletId,
					name: target.name
				};
			},
			{ isolationLevel: "ReadCommitted" }
		)
	);
}
