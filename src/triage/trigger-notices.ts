import chats from "../services/chats.service";
import distribution from "../services/messages-distribution.service";
import ProcessingLogger from "../utils/processing-logger";
import type { Prisma, TriageTriggerNotice, WppChat } from "@prisma/client";
import db from "../services/prisma.service";
import { triageEnabled } from "./access";
import { triageTriggers } from "./triggers";
import { latestTriageInbound, startTriggeredTriage } from "./trigger-start";
import { withDatabaseTenant } from "../utils/database-tenant-context";

export async function enqueueTriageNotice(tx: Prisma.TransactionClient, chat: WppChat, type: "closed" | "transfer") {
	if (
		!chat.sectorId ||
		!chat.contactId ||
		(type === "transfer" && (chat.botId != null || chat.agentId != null || (chat.userId ?? 0) > 0))
	)
		return;
	if (!(await triageEnabled(tx, chat.instance))) return;
	const message = await latestTriageInbound(tx, chat.instance, chat.id);
	if (!message?.clientId) return;
	// Preview without a publication lock: the chat row is already locked by the transition.
	// The dispatcher checks this same version and rule again under the channel lock.
	const match = await triageTriggers.match(chat.instance, message.clientId, { type, sectorId: chat.sectorId }, tx);
	if (!match) return;
	if (
		type === "closed" &&
		(await tx.triageRun.findFirst({
			where: { instance: chat.instance, chatId: chat.id, kind: "closed" },
			select: { id: true }
		}))
	)
		return;
	await tx.triageTriggerNotice.create({
		data: {
			instance: chat.instance,
			chatId: chat.id,
			kind: type,
			channelId: message.clientId,
			sectorId: chat.sectorId,
			userId: chat.userId,
			resultId: chat.resultId,
			messageId: message.id,
			botId: match.botId,
			versionId: match.versionId
		}
	});
}

export async function processTriageNotice(row: TriageTriggerNotice) {
	if (row.status !== "pending" || (row.kind !== "transfer" && row.kind !== "closed")) return;
	const kind = row.kind;
	await withDatabaseTenant(row.instance, async () => {
		try {
			const outcome = await startTriggeredTriage({
				instance: row.instance,
				channelId: row.channelId,
				chatId: row.chatId,
				type: kind,
				eventKey: String(row.id),
				sectorId: row.sectorId,
				botId: row.botId ?? row.channelId,
				expectedVersion: row.versionId,
				expectedMessage: row.messageId,
				expectedUserId: row.userId,
				...(row.resultId != null && { resultId: row.resultId })
			});
			await db.triageTriggerNotice.updateMany({
				where: { id: row.id, status: "pending" },
				data: { status: outcome ? "started" : "skipped" }
			});
			if (outcome?.started) {
				await chats.syncChatToLocal(outcome.chat);
				await distribution.notifyChatStarted(
					new ProcessingLogger(row.instance, "triage-trigger", String(row.id), {}),
					outcome.chat
				);
			}
		} catch (error) {
			const attempts = row.attempts + 1;
			await db.triageTriggerNotice.updateMany({
				where: { id: row.id, status: "pending", attempts: row.attempts },
				data: {
					attempts,
					retryAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** attempts)),
					status: attempts >= 6 ? "failed" : "pending"
				}
			});
			console.error("[triage] Falha ao processar gatilho", {
				instance: row.instance,
				noticeId: row.id,
				attempts,
				code: (error as { code?: string })?.code
			});
		}
	});
}
export async function drainTriageNotices() {
	const rows = await db.triageTriggerNotice.findMany({
		where: { status: "pending", retryAt: { lte: new Date() } },
		take: 25,
		orderBy: { id: "asc" }
	});
	for (const row of rows) await processTriageNotice(row);
}
