import { Logger } from "@in.pulse-crm/utils";
import type { SessionData, SocketServerChatRoom } from "../sdk-local";
import { SocketEventType } from "../sdk-local";
import type { MessageReactionEvent } from "../types/remote-client.types";
import type WhatsappClient from "../whatsapp-client/whatsapp-client";
import { canonicalReactionTarget, MessageReactionError, reactionActor, reactionEmoji, reactionTimestamp } from "../utils/message-reaction";
import prismaService, { type DatabaseClient } from "./prisma.service";
import messageReactionsRepository, { MessageReactionsRepository } from "./message-reactions.repository";
import type { MessageReactionSnapshot } from "./message-reactions.types";
import socketService from "./socket.service";
import parametersService from "./parameters.service";
import { assertWabaReactionTarget, parseWabaReaction, wabaPhone, wabaReactionActorIds } from "../utils/waba-reaction";
import { WabaReactionReceiptsService, type WabaReactionReceiptDatabase } from "./waba-reaction-receipts.service";

type Domain = "wpp" | "internal";
type ReactionMessage = {
	id: number; instance: string; clientId?: number | null;
	wwebjsId?: string | null; wwebjsIdStanza?: string | null; wabaId?: string | null; gupshupId?: string | null;
	from?: string; to?: string; type?: string; status?: string; timestamp?: unknown; sentAt?: unknown;
};
type ReactionClient = Pick<WhatsappClient, "id" | "instance" | "sendReaction">;
export interface MessageReactionUpdate extends MessageReactionSnapshot {
	messageId: number; messageType: Domain; clientId: number; reaction: string;
}

export class MessageReactionsService {
	constructor(
		private readonly db: DatabaseClient = prismaService,
		private readonly repository: MessageReactionsRepository = messageReactionsRepository,
		private readonly emit: (room: string, data: MessageReactionUpdate) => Promise<unknown> = (room, data) =>
			socketService.emit(SocketEventType.WppMessageReaction, room as SocketServerChatRoom, data),
		private readonly groupsEnabled: (instance: string, defaultValue: boolean) => Promise<boolean> = (instance, fallback) =>
			parametersService.isInternalGroupWhatsappSyncEnabled(instance, fallback),
		private readonly receiptJournal: (db: WabaReactionReceiptDatabase) => Pick<WabaReactionReceiptsService, "prepare" | "accept" | "unknown" | "reject"> = db => new WabaReactionReceiptsService(db),
	) {}

	async hydrate<T extends ReactionMessage>(instance: string, messages: T[], domain: Domain = "wpp"): Promise<Array<T & MessageReactionSnapshot>> {
		const snapshots = await this.repository.hydrate(instance, messages.filter((m) => m.instance === instance).map((m) => ({
			domain: domain === "wpp" ? "WPP" as const : "INTERNAL" as const, messageId: m.id, clientId: m.clientId ?? null,
			targetMessageIds: [...new Set([m.wwebjsIdStanza, m.wwebjsId, m.wabaId, m.gupshupId]
				.filter((id): id is string => !!id).map(canonicalReactionTarget))],
			...(m.wabaId ? { allowedActorIds: wabaReactionActorIds(m) } : {}),
		})));
		return messages.map((message) => {
			const snapshot = (message.instance === instance ? snapshots.get(`${domain === "wpp" ? "WPP" : "INTERNAL"}:${message.id}`) : undefined)
				?? { reactions: [], reactionsUpdatedAt: null };
			// Reactions may precede the target. Recheck the peer when it becomes available,
			// so a pending event cannot attach to a different contact sharing this channel.
			const peer = message.wabaId ? wabaPhone(message.from?.startsWith("me:") ? message.to : message.from) : null;
			return { ...message, ...snapshot, reactions: message.wabaId
				? snapshot.reactions.filter((reaction) => reaction.fromMe || (!!peer && reaction.actorId === `${peer}@s.whatsapp.net`))
				: snapshot.reactions };
		});
	}

	/** Persist even before the target arrives. Provider retries may safely repeat this call. */
	async receive(client: { id: number; instance: string }, event: MessageReactionEvent, groupSyncDefault = true): Promise<void> {
		if (event.clientId !== client.id || typeof event.targetMessageId !== "string" || !event.targetMessageId || event.targetMessageId.length > 191) {
			throw new MessageReactionError("Evento de reação não pertence ao canal ou possui alvo inválido.");
		}
		if (event.isGroup && (!event.groupId || !await this.groupsEnabled(client.instance, groupSyncDefault))) return;
		const targetMessageId = canonicalReactionTarget(event.targetMessageId);
		const emoji = reactionEmoji(event.removed ? "" : event.reaction);
		const actorId = reactionActor(event.actorId, event.fromMe === true);
		if (actorId.length > 191) throw new MessageReactionError("Identidade da reação inválida.");
		await this.repository.apply({
			instance: client.instance, clientId: client.id, targetMessageId, actorId,
			fromMe: event.fromMe === true, emoji, reactedAt: reactionTimestamp(event.timestamp),
			sourceEventId: event.reactionId ? canonicalReactionTarget(event.reactionId).slice(0, 191) : null,
		});
		const ids = [...new Set([event.targetMessageId, targetMessageId])];
		if (event.isGroup) {
			const message = await this.db.internalMessage.findFirst({ where: {
				instance: client.instance, clientId: client.id,
				chat: { instance: client.instance, wppGroupId: event.groupId },
				OR: [{ wwebjsId: { in: ids } }, { wwebjsIdStanza: { in: ids } }],
			} });
			if (message) await this.publish(message, "internal", message.internalChatId, client.id);
		} else {
			const message = await this.db.wppMessage.findFirst({ where: {
				instance: client.instance, clientId: client.id,
				OR: [{ wwebjsId: { in: ids } }, { wwebjsIdStanza: { in: ids } }, { wabaId: { in: ids } }, { gupshupId: { in: ids } }],
			} });
			if (message?.chatId) await this.publish(message, "wpp", message.chatId, client.id);
		}
	}

	async sendWpp(session: SessionData, clientId: number, messageId: number, rawEmoji: unknown, getClient: (id: number) => ReactionClient | undefined) {
		const emoji = reactionEmoji(rawEmoji);
		const message = await this.db.wppMessage.findFirst({ where: { id: messageId, instance: session.instance, clientId } });
		if (!message?.chatId) throw new MessageReactionError("Mensagem não encontrada neste canal.", 404);
		const chat = await this.db.wppChat.findFirst({ where: {
			id: message.chatId, instance: session.instance,
			...(session.instance === "nunes" && session.sectorId !== 3 ? { sectorId: session.sectorId } : {}),
		} });
		if (!chat || chat.isFinished) throw new MessageReactionError("Conversa indisponível para reação.", 403);
		const to = (message.from.startsWith("me:") ? message.to : message.from).replace(/^me:/, "");
		return this.dispatch(session, message, "wpp", message.chatId, clientId, to, emoji, getClient);
	}

	/** Official incoming reactions update metadata only; they never insert/distribute a chat message. */
	async receiveWaba(client: { id: number; instance: string; phone?: string | null }, input: unknown): Promise<void> {
		const event = parseWabaReaction(client.id, input);
		const target = await this.db.wppMessage.findFirst({ where: { instance: client.instance, clientId: client.id, wabaId: event.targetMessageId } });
		if (target) {
			const peer = wabaPhone(target.from.startsWith("me:") ? target.to : target.from);
			const own = wabaPhone(target.from.startsWith("me:") ? target.from.slice(3) : target.to.replace(/^me:/, ""));
			const copiedOdim = client.instance === "odim" && (target.from.startsWith("me:") ? target.from : target.to) === "me:odim-legacy-copy";
			if (!peer || event.actorId !== `${peer}@s.whatsapp.net` || (!copiedOdim && (!own || own !== wabaPhone(client.phone)))) {
				throw new MessageReactionError("Reação WABA não pertence ao destinatário desta mensagem.", 409);
			}
		}
		await this.receive(client, event);
	}

	async refreshWabaTarget(instance: string, clientId: number, targetMessageId: string): Promise<void> {
		const message = await this.db.wppMessage.findFirst({ where: { instance, clientId, wabaId: targetMessageId } });
		if (message?.chatId) await this.publish(message, "wpp", message.chatId, clientId);
	}

	async sendInternal(session: SessionData, messageId: number, rawEmoji: unknown, getClient: (id: number) => ReactionClient | undefined) {
		const emoji = reactionEmoji(rawEmoji);
		const message = await this.db.internalMessage.findFirst({ where: {
			id: messageId, instance: session.instance,
			chat: { instance: session.instance, isFinished: false, participants: { some: { userId: session.userId } } },
		}, include: { chat: true } });
		if (!message?.chat?.wppGroupId || !message.clientId) throw new MessageReactionError("Mensagem sem canal WhatsApp vinculado ou conversa não autorizada.", 404);
		return this.dispatch(session, message, "internal", message.internalChatId, message.clientId, message.chat.wppGroupId, emoji, getClient);
	}

	private async dispatch(session: SessionData, message: ReactionMessage, domain: Domain, chatId: number, clientId: number, to: string, emoji: string, getClient: (id: number) => ReactionClient | undefined) {
		const registered = await this.db.wppClient.findFirst({ where: { id: clientId, instance: session.instance, isActive: true } });
		const client = getClient(clientId);
		if (!registered || !client || client.id !== clientId || client.instance !== session.instance) throw new MessageReactionError("Canal indisponível.", 503);
		if (!client.sendReaction) throw new MessageReactionError("Este provedor ainda não suporta envio de reações.", 501, "REACTION_UNSUPPORTED");
		if (domain === "internal" && !await this.groupsEnabled(session.instance, registered.type === "REMOTE")) {
			throw new MessageReactionError("Sincronização WhatsApp deste grupo está desativada.", 409);
		}
		if (registered.type === "WABA" && domain !== "wpp") throw new MessageReactionError("Reação WABA disponível somente em atendimento individual.", 409);
		const recipient = registered.type === "WABA" ? wabaPhone(to) : to;
		if (!recipient) throw new MessageReactionError("Destinatário de reação inválido.", 409);
		const providerId = registered.type === "WABA" ? assertWabaReactionTarget(message, recipient, registered.phone) :
			registered.type === "WWEBJS" ? message.wwebjsId : message.wwebjsIdStanza || message.wwebjsId || message.wabaId || message.gupshupId;
		if (!providerId) throw new MessageReactionError("Aguarde a confirmação da mensagem antes de reagir.", 409);
		const journal = registered.type === "WABA" ? this.receiptJournal(this.db) : null;
		const operation = await journal?.prepare({ instance: session.instance, clientId, targetMessageId: providerId,
			to: recipient, emoji, internalUserId: session.userId, internalUserName: session.name?.trim().slice(0, 191) || null });
		let receipt;
		try {
			receipt = await client.sendReaction({ to: recipient, messageId: providerId, emoji, isGroup: domain === "internal",
				...(operation ? { wabaCallbackData: operation.callbackData } : {}) });
		} catch (error) {
			if (operation && journal) {
				try { await (error instanceof MessageReactionError && error.code === "REACTION_REJECTED" ? journal.reject(operation.id) : journal.unknown(operation.id)); }
				catch (failure) { Logger.error("[Reactions] Unable to record uncertain WABA operation", failure as Error); }
			}
			if (error instanceof MessageReactionError) throw error;
			throw new MessageReactionError("Não foi possível confirmar a reação. Aguarde a atualização da conversa antes de tentar novamente.", 502, "REACTION_DELIVERY_UNKNOWN");
		}
		if (!receipt || typeof receipt !== "object" || receipt.contractVersion !== 1 || receipt.status !== "SENT" || receipt.fromMe !== true ||
			typeof receipt.targetMessageId !== "string" || !Number.isFinite(receipt.timestamp) || receipt.timestamp <= 0 ||
			typeof receipt.reactionId !== "string" || !receipt.reactionId || receipt.removed !== (emoji === "") ||
			canonicalReactionTarget(receipt.targetMessageId) !== canonicalReactionTarget(providerId) || receipt.reaction !== emoji) {
			if (operation && journal) {
				try { await journal.unknown(operation.id); }
				catch (error) { Logger.error(`[Reactions] WABA operation ${operation.id} has an unconfirmed receipt`, error as Error); }
			}
			throw new MessageReactionError("Resposta de reação inválida; resultado incerto.", 502, "REACTION_DELIVERY_UNKNOWN");
		}
		let data: MessageReactionUpdate;
		try {
			if (operation) {
				// The ledger owns ordering/materialization under the same target lock as statuses.
				// Never follow accept with a separate repository write: FAILED can arrive early.
				const accepted = await this.db.$transaction(tx => this.receiptJournal(tx).accept(operation.id, receipt.reactionId));
				if (["FAILED", "REJECTED"].includes(accepted.status)) throw new MessageReactionError("O WhatsApp oficial rejeitou a reação.", 409, "REACTION_REJECTED");
			} else await this.repository.apply({
				instance: session.instance, clientId, targetMessageId: canonicalReactionTarget(providerId),
				actorId: "self", fromMe: true, emoji, reactedAt: reactionTimestamp(receipt.timestamp),
				sourceEventId: canonicalReactionTarget(receipt.reactionId).slice(0, 191),
				internalUserId: session.userId, internalUserName: session.name?.trim().slice(0, 191) || null,
			});
			data = await this.snapshot(message, domain, clientId);
		} catch (error) {
			if (error instanceof MessageReactionError && error.code === "REACTION_REJECTED") throw error;
			if (operation && journal) {
				try { await journal.unknown(operation.id); }
				catch (failure) { Logger.error(`[Reactions] WABA operation ${operation.id} outcome remains uncertain`, failure as Error); }
				Logger.error(`[Reactions] WABA receipt requires reconciliation: operation=${operation.id} provider=${receipt.reactionId}`, error as Error);
			}
			Logger.error("[Reactions] Provider accepted reaction but persistence failed", error as Error);
			throw new MessageReactionError("Reação aceita pelo provedor, mas ainda não sincronizada. Não repetir automaticamente.", 502, "REACTION_DELIVERY_UNKNOWN");
		}
		// A socket failure must not change a confirmed HTTP operation into a retry.
		try { await this.emit(this.room(message.instance, domain, chatId), data); }
		catch (error) { Logger.error("[Reactions] Socket notification failed; reaction remains persisted", error as Error); }
		return data;
	}

	private async snapshot(message: ReactionMessage, domain: Domain, clientId: number): Promise<MessageReactionUpdate> {
		const [hydrated] = await this.hydrate(message.instance, [message], domain);
		const reactions = hydrated!.reactions;
		return { messageId: message.id, messageType: domain, clientId, reactions,
			reactionsUpdatedAt: hydrated!.reactionsUpdatedAt, reaction: reactions.at(-1)?.emoji ?? "" };
	}
	private room(instance: string, domain: Domain, chatId: number) { return `${instance}:${domain === "wpp" ? "chat" : "internal-chat"}:${chatId}`; }
	private async publish(message: ReactionMessage, domain: Domain, chatId: number, clientId: number) {
		await this.emit(this.room(message.instance, domain, chatId), await this.snapshot(message, domain, clientId));
	}
}

export default new MessageReactionsService();
