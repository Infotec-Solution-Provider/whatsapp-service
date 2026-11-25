import { Prisma, TriageEffect, WppChat, WppMessage } from "@prisma/client";
import { ConflictError } from "@rgranatodutra/http-errors";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import db from "../services/prisma.service";
import chatPreferences from "../services/chat-user-preferences.service";
import {
	cancelTriageTx,
	definitionOf,
	expireTriage,
	lockSession,
	noTriageTables,
	recordSummary,
	TRIAGE_CHAT_MARKER
} from "./runtime";
import ProcessingLogger from "../utils/processing-logger";
import chats from "../services/chats.service";
import distribution from "../services/messages-distribution.service";
import messages from "../services/messages.service";
import whatsapp from "../services/whatsapp.service";
import { tenantSqlEnabled } from "../tenant-sql/registry";
import { tenantSqlInstanceNames } from "../tenant-sql/router";
import { AsyncConcurrencyLimiter } from "../utils/async-concurrency-limiter";

const FUTURE_LEASE_MS = 5 * 60_000;
const providerSlots = new AsyncConcurrencyLimiter(3);
async function boundedProviderCall<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("TRIAGE_PROVIDER_TIMEOUT")), 45_000);
				timer.unref();
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}
const open = ["waiting", "handoff"];
type EffectPayload = { text?: string; sectorId?: number; reason?: string };
function payloadOf(effect: TriageEffect) {
	return effect.payload as EffectPayload;
}

async function refresh(chat: WppChat, summary: WppMessage[] = []) {
	// The transaction already committed. Subscribers can also recover from the change stream.
	await chats.syncChatToLocal(chat);
	for (const message of summary) {
		await messages.syncMessageToLocal(message);
		await distribution.notifyMessage(null, message);
	}
	await distribution.notifyChatStarted(new ProcessingLogger(chat.instance, "triage", "chat-" + chat.id, {}), chat);
}

export async function takeOverTriage(
	instance: string,
	chatId: number,
	userId: number,
	scopeSectorId?: number,
	scopeChannelId?: number,
	authorizeTx?: (tx: Prisma.TransactionClient) => Promise<void>
) {
	if (!Number.isSafeInteger(userId) || userId <= 0) throw new ConflictError("Operador inválido.");
	let summary: WppMessage[] | undefined;
	const result = await chatPreferences.withUnreadAssignment(
		async (tx) => {
			if (authorizeTx) await authorizeTx(tx);
			const session = await lockSession(tx, instance, chatId);
			const chat = await tx.wppChat.findFirst({ where: { instance, id: chatId, isFinished: false } });
			if (
				!session ||
				!chat ||
				(scopeSectorId != null && chat.sectorId !== scopeSectorId) ||
				(scopeChannelId != null && session.channelId !== scopeChannelId)
			)
				throw new ConflictError("A triagem não está disponível neste atendimento.");
			if (session.status === "taken" && chat.userId === userId) return chat;
			if (!open.includes(session.status) || chat.botId !== TRIAGE_CHAT_MARKER)
				throw new ConflictError("O atendimento já saiu da triagem.");
			summary = await cancelTriageTx(tx, chat);
			const updated = await tx.wppChat.update({
				where: { id: chatId, instance, isFinished: false, botId: TRIAGE_CHAT_MARKER, userId: chat.userId },
				data: { userId, botId: null, agentId: null, walletId: null }
			});
			await tx.wppChatTransferHistory.create({
				data: {
					instance,
					chatId,
					fromUserId: chat.userId,
					toUserId: userId,
					fromSectorId: chat.sectorId,
					toSectorId: chat.sectorId,
					initiatedByUserId: userId,
					source: "manual",
					reason: "Triagem assumida pelo operador"
				}
			});
			return updated;
		},
		{ instance, recipientId: userId, chatId },
		"ReadCommitted"
	);
	await refresh(result, summary);
	return result;
}

async function claim(candidate: TriageEffect) {
	return db.$transaction(
		async (tx) => {
			const session = await lockSession(tx, candidate.instance, candidate.chatId);
			if (!session || !open.includes(session.status)) return null;
			const effect = await tx.triageEffect.findUnique({ where: { id: candidate.id } });
			if (!effect || effect.status !== "pending" || effect.retryAt.getTime() > Date.now()) return null;
			const older = await tx.triageEffect.findFirst({
				where: {
					instance: effect.instance,
					chatId: effect.chatId,
					id: { lt: effect.id },
					status: { in: ["pending", "working", "sending"] }
				}
			});
			if (older) return null;
			const chat = await tx.wppChat.findFirstOrThrow({ where: { instance: effect.instance, id: effect.chatId } });
			if (chat.botId !== TRIAGE_CHAT_MARKER || chat.isFinished || (chat.userId ?? 0) > 0) {
				await cancelTriageTx(tx, { ...chat, botId: TRIAGE_CHAT_MARKER });
				return null;
			}
			const owned = await tx.triageEffect.update({
				where: { id: effect.id },
				data: { status: "working", attempts: { increment: 1 }, retryAt: new Date(Date.now() + FUTURE_LEASE_MS) }
			});
			return { session, effect: owned, chat };
		},
		{ isolationLevel: "ReadCommitted" }
	);
}
type Claimed = NonNullable<Awaited<ReturnType<typeof claim>>>;

async function fallback(tx: Prisma.TransactionClient, item: TriageEffect, reason: string) {
	const session = await lockSession(tx, item.instance, item.chatId);
	if (!session || !open.includes(session.status)) return;
	await tx.triageEffect.updateMany({
		where: { instance: item.instance, chatId: item.chatId, status: "pending" },
		data: { status: "cancelled" }
	});
	await tx.triageSession.update({ where: { chatId: session.chatId }, data: { status: "handoff", deadline: null } });
	const event = await tx.triageEvent.create({
		data: { instance: item.instance, chatId: item.chatId, kind: reason, eventKey: "incident:" + item.id }
	});
	await tx.triageEffect.create({
		data: {
			instance: item.instance,
			chatId: item.chatId,
			eventId: event.id,
			position: 0,
			kind: "handoff",
			status: "pending",
			payload: { sectorId: definitionOf(session).fallbackSectorId, reason }
		}
	});
}

async function fail(effect: TriageEffect) {
	await db.$transaction(
		async (tx) => {
			await lockSession(tx, effect.instance, effect.chatId);
			const row = await tx.triageEffect.findUniqueOrThrow({ where: { id: effect.id } });
			if (row.attempts !== effect.attempts || !["working", "sending"].includes(row.status)) return;
			const unknown = row.status === "sending";
			if (!unknown && row.attempts < 3) {
				await tx.triageEffect.update({
					where: { id: row.id },
					data: {
						status: "pending",
						error: "RETRY",
						retryAt: new Date(Date.now() + 1000 * 2 ** row.attempts)
					}
				});
				return;
			}
			await tx.triageEffect.update({
				where: { id: row.id },
				data: {
					status: unknown ? "unknown" : "failed",
					error: unknown ? "DELIVERY_UNCONFIRMED" : "ACTION_UNAVAILABLE"
				}
			});
			if (unknown && row.messageId)
				await tx.wppMessage.updateMany({
					where: { id: row.messageId, status: "PENDING" },
					data: { status: "UNKNOWN" }
				});
			if (
				row.kind === "message" ||
				(payloadOf(row).reason !== "unavailable" && payloadOf(row).reason !== "delivery")
			) {
				await fallback(tx, row, row.kind === "message" ? "delivery" : "unavailable");
			}
			console.error("[triage] Ação requer atenção", {
				instance: row.instance,
				chatId: row.chatId,
				effectId: row.id,
				unknown
			});
		},
		{ isolationLevel: "ReadCommitted" }
	);
}

async function deliver({ effect, session, chat }: Claimed) {
	const client = whatsapp.getClient(session.channelId);
	if (!client || client.instance !== session.instance) throw new Error("TRIAGE_CHANNEL_UNAVAILABLE");
	const source = await db.wppMessage.findFirstOrThrow({
		where: {
			instance: session.instance,
			chatId: session.chatId,
			id: session.lastMessageId,
			clientId: session.channelId
		}
	});
	const text = payloadOf(effect).text!;
	const now = new Date();
	// Persist the provider submission boundary before any external I/O.
	const pending = await db.$transaction(
		async (tx) => {
			const current = await lockSession(tx, session.instance, chat.id);
			const row = await tx.triageEffect.findUniqueOrThrow({ where: { id: effect.id } });
			if (
				!current ||
				!open.includes(current.status) ||
				row.status !== "working" ||
				row.attempts !== effect.attempts
			)
				return null;
			const message = await tx.wppMessage.create({
				data: {
					instance: session.instance,
					status: "PENDING",
					timestamp: String(now.getTime()),
					sentAt: now,
					from: "bot:triagem",
					to: source.from,
					type: "chat",
					body: text,
					clientId: client.id,
					chatId: chat.id,
					contactId: session.contactId
				}
			});
			await tx.triageEffect.update({
				where: { id: effect.id },
				data: { status: "sending", messageId: message.id, retryAt: new Date(now.getTime() + FUTURE_LEASE_MS) }
			});
			return message;
		},
		{ isolationLevel: "ReadCommitted" }
	);
	if (!pending) return;
	const result = await boundedProviderCall(client.sendMessage({ to: source.from, text }, false));
	if (
		!result ||
		result.status === "UNKNOWN" ||
		result.status === "ERROR" ||
		!(result.wabaId || result.wwebjsId || result.wwebjsIdStanza || result.gupshupId)
	)
		throw new Error("TRIAGE_SUBMISSION_UNCONFIRMED");
	const sent = await db.$transaction(async (tx) => {
		await lockSession(tx, session.instance, chat.id);
		const fields = {
			wabaId: result.wabaId ?? null,
			gupshupId: result.gupshupId ?? null,
			wwebjsId: result.wwebjsId ?? null,
			wwebjsIdStanza: result.wwebjsIdStanza ?? null
		};
		await tx.wppMessage.updateMany({
			where: { id: pending.id, status: { in: ["PENDING", "UNKNOWN"] } },
			data: { ...fields, status: "SENT" }
		});
		await tx.triageEffect.update({ where: { id: effect.id }, data: { status: "done", error: null } });
		return tx.wppMessage.findUniqueOrThrow({ where: { id: pending.id } });
	});
	await messages.syncMessageToLocal(sent);
	await distribution.notifyMessage(null, sent);
}

async function handoff({ effect, session }: Claimed) {
	const { instance, chatId, channelId } = session;
	const { sectorId, reason } = payloadOf(effect);
	const channel = await db.wppClient.findFirstOrThrow({
		where: { id: channelId, instance },
		include: { sectors: true }
	});
	if (!sectorId || !channel.sectors.some((s) => s.id === sectorId && s.instance === instance))
		throw new Error("TRIAGE_SECTOR_UNAVAILABLE");
	const contact = await db.wppContact.findFirstOrThrow({ where: { instance, id: session.contactId } });
	const message = await db.wppMessage.findFirstOrThrow({ where: { instance, id: session.lastMessageId, chatId } });
	const flow = await distribution.getFlow(instance, sectorId);
	const assignment = await flow.getChatPayload(
		new ProcessingLogger(instance, "triage-handoff", String(chatId), {}),
		contact,
		message
	);
	if (
		assignment.sectorId !== sectorId ||
		assignment.instance !== instance ||
		assignment.contactId !== session.contactId
	)
		throw new Error("TRIAGE_DESTINATION_MISMATCH");
	let summary: WppMessage[] | undefined;
	const chat = await chatPreferences.withUnreadAssignment(
		async (tx) => {
			const destination = await tx.$queryRawUnsafe<{ id: number }[]>(
				"SELECT s.id FROM clients c JOIN _sector_clients sc ON sc.A=c.id JOIN sectors s ON s.id=sc.B " +
					"WHERE c.instance=? AND c.id=? AND s.instance=? AND s.id=? AND s.receive_chats=1 FOR UPDATE",
				instance,
				channelId,
				instance,
				sectorId
			);
			if (!destination.length) throw new Error("TRIAGE_SECTOR_UNAVAILABLE");
			const current = await lockSession(tx, instance, chatId);
			const before = await tx.wppChat.findFirstOrThrow({ where: { id: chatId, instance } });
			const row = await tx.triageEffect.findUniqueOrThrow({ where: { id: effect.id } });
			if (
				!current ||
				current.status !== "handoff" ||
				before.isFinished ||
				before.botId !== TRIAGE_CHAT_MARKER ||
				row.status !== "working" ||
				row.attempts !== effect.attempts
			)
				return before;
			const updated = await tx.wppChat.update({
				where: { id: chatId, instance, botId: TRIAGE_CHAT_MARKER, userId: before.userId, isFinished: false },
				data: {
					sectorId,
					walletId: assignment.walletId ?? null,
					userId: assignment.userId ?? null,
					agentId: null,
					botId: null,
					...(assignment.priority ? { priority: assignment.priority } : {})
				}
			});
			summary = await recordSummary(tx, current, reason ?? "configured");
			await tx.wppChatTransferHistory.create({
				data: {
					instance,
					chatId,
					fromUserId: before.userId,
					toUserId: updated.userId,
					fromSectorId: before.sectorId,
					toSectorId: updated.sectorId,
					source: "auto-sector",
					reason: "Encaminhamento da triagem"
				}
			});
			await tx.triageSession.update({ where: { chatId }, data: { status: "handed_off", deadline: null } });
			await tx.triageEffect.update({ where: { id: row.id }, data: { status: "done", error: null } });
			await tx.triageEvent.create({
				data: { instance, chatId, eventKey: "handoff:" + chatId, kind: "handed_off" }
			});
			return updated;
		},
		{ instance, chatId, recipientId: assignment.userId },
		"ReadCommitted"
	);
	if (summary) await refresh(chat, summary);
}

export async function serviceTriageEffect(candidate: TriageEffect) {
	return withDatabaseTenant(candidate.instance, async () => {
		const claimed = await claim(candidate);
		if (!claimed) return;
		try {
			if (candidate.kind === "message") await deliver(claimed);
			else await handoff(claimed);
		} catch {
			await fail(claimed.effect);
		}
	});
}

export async function drainTriage() {
	const now = new Date();
	const expired = await db.triageEffect.findMany({
		where: { status: { in: ["working", "sending"] }, retryAt: { lte: now } },
		take: 50,
		orderBy: { retryAt: "asc" }
	});
	for (const row of expired) await withDatabaseTenant(row.instance, () => fail(row));
	const timers = await db.triageSession.findMany({
		where: { status: "waiting", deadline: { lte: now } },
		take: 50,
		orderBy: { deadline: "asc" },
		select: { instance: true, chatId: true }
	});
	for (const timer of timers) await expireTriage(timer.instance, timer.chatId, now);
	// Select only each conversation's next action. A slow number must not occupy the whole batch.
	const heads = await db.$queryRawUnsafe<{ id: number }[]>(
		"SELECT e.id FROM triage_effects e WHERE e.status='pending' AND e.retry_at<=? AND NOT EXISTS (" +
			"SELECT 1 FROM triage_effects prev WHERE prev.instance=e.instance AND prev.chat_id=e.chat_id AND prev.id<e.id " +
			"AND prev.status IN ('pending','working','sending')) ORDER BY e.id LIMIT 50",
		now
	);
	if (!heads.length) return;
	const pending = await db.triageEffect.findMany({
		where: { id: { in: heads.map((row) => Number(row.id)) }, status: "pending" }
	});
	await Promise.all(pending.map((item) => providerSlots.run(() => serviceTriageEffect(item))));
}

let worker: ReturnType<typeof setInterval> | undefined;
let draining: Promise<void> | undefined;
const unavailableUntil = new Map<string, number>();
async function tick() {
	const scopes = tenantSqlEnabled() ? tenantSqlInstanceNames() : [""];
	for (const scope of scopes) {
		if ((unavailableUntil.get(scope) ?? 0) > Date.now()) continue;
		try {
			await (scope ? withDatabaseTenant(scope, drainTriage) : drainTriage());
		} catch (error) {
			if (!noTriageTables(error))
				console.error("[triage] Falha ao ler eventos pendentes.", {
					instance: scope,
					code: (error as { code?: string })?.code
				});
			unavailableUntil.set(scope, Date.now() + 60_000);
		}
	}
}
export function startTriageWorker() {
	if (worker) return;
	worker = setInterval(() => {
		if (!draining)
			draining = tick().finally(() => {
				draining = undefined;
			});
	}, 2000);
	worker.unref();
}
export async function stopTriageWorker() {
	clearInterval(worker);
	worker = undefined;
	await draining;
}
