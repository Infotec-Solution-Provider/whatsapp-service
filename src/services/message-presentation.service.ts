import messageMentionsService from "./message-mentions.service";
import messageReactionsService from "./message-reactions.service";
import type { MentionEntity } from "../utils/message-mention-metadata";
import { normalizeMentionEntities } from "../utils/message-mention-metadata";
import type { MessageReactionSnapshot } from "./message-reactions.types";
import prismaService from "./prisma.service";
import { parseQueuePayload, whatsappRetryHint, type InternalWppOutcome, type WhatsappRetryHint } from "../utils/internal-wpp-send-outcome";

type PresentableMessage = {
	id: number; instance: string; clientId?: number | null; internalChatId?: number;
	wwebjsId?: string | null; wwebjsIdStanza?: string | null; wabaId?: string | null; gupshupId?: string | null;
	mentionMetadata?: unknown; mentionEntities?: unknown;
	status?: string;
};

type SendAttemptError = { status: string; error: string | null };
type SendErrorPresentation = { sendError?: string | null };
type RetryPresentation = { whatsappRetry?: WhatsappRetryHint | null };

const RETRY_HINT_BATCH = 100;

/** Outcome-only resend hints for ERROR internal messages of WhatsApp-linked chats. */
async function internalRetryHints(instance: string, messages: PresentableMessage[]): Promise<Map<number, WhatsappRetryHint>> {
	const failed = messages.filter((message) => message.instance === instance && message.status === "ERROR");
	const hints = new Map<number, WhatsappRetryHint>();
	if (!failed.length) return hints;
	const chatIds = [...new Set(failed.map((message) => message.internalChatId).filter((id): id is number => typeof id === "number"))];
	const linked = new Set<number>();
	for (let offset = 0; offset < chatIds.length; offset += RETRY_HINT_BATCH) {
		const chats = await prismaService.internalChat.findMany({
			where: { id: { in: chatIds.slice(offset, offset + RETRY_HINT_BATCH) }, instance, wppGroupId: { not: null } },
			select: { id: true },
		});
		for (const chat of chats) linked.add(chat.id);
	}
	const ids = failed.filter((message) => linked.has(message.internalChatId ?? -1)).map((message) => message.id);
	for (let offset = 0; offset < ids.length; offset += RETRY_HINT_BATCH) {
		const batch = ids.slice(offset, offset + RETRY_HINT_BATCH);
		const rows = await prismaService.internalMessageProcessingQueue.findMany({
			where: { instance, internalMessageId: { in: batch } },
			select: { internalMessageId: true, messageData: true },
		});
		const byMessage = new Map(rows.map((row) => [row.internalMessageId, row]));
		for (const id of batch) {
			const row = byMessage.get(id);
			const payload = parseQueuePayload<{ retryGeneration?: number; outcome?: InternalWppOutcome }>(row?.messageData);
			hints.set(id, whatsappRetryHint({ exists: !!row, retryGeneration: payload?.retryGeneration, outcome: payload?.outcome }));
		}
	}
	return hints;
}

function sendError(message: { status?: string }, attempt?: SendAttemptError): SendErrorPresentation {
	const matching = (message.status === "ERROR" && attempt?.status === "FAILED")
		|| (message.status === "UNKNOWN" && attempt?.status === "UNKNOWN");
	return matching && attempt?.error ? { sendError: attempt.error.slice(0, 4_000) } : {};
}

/** Batch enrichments without changing the persisted message body. */
class MessagePresentationService {
	/** Mutation responses need no extra database work after a send was accepted. */
	fromStored<T extends { mentionMetadata?: unknown; mentionEntities?: unknown; status?: string }>(message: T, attempt?: SendAttemptError):
		Omit<T, "mentionMetadata" | "mentionEntities"> & { mentionEntities?: MentionEntity[] } & SendErrorPresentation {
		const { mentionMetadata, mentionEntities, ...rest } = message;
		// A hydrated DTO contains current names; the stored snapshot is its fallback.
		const value = mentionEntities ?? mentionMetadata;
		return { ...rest, ...sendError(message, attempt), ...(value == null ? {} : { mentionEntities: normalizeMentionEntities(value) }) };
	}

	async hydrate<T extends PresentableMessage>(instance: string, messages: T[], domain: "wpp" | "internal" = "wpp"):
		Promise<Array<Omit<T & MessageReactionSnapshot, "mentionMetadata" | "mentionEntities"> & { mentionEntities?: MentionEntity[] } & SendErrorPresentation & RetryPresentation>> {
		// Successful/pending and internal messages need no outbound-attempt query.
		const failedIds = domain === "wpp" ? messages.filter((message) => message.instance === instance
			&& (message.status === "ERROR" || message.status === "UNKNOWN")).map((message) => message.id) : [];
		const [mentions, reactions, attempts, retryHints] = await Promise.all([
			messageMentionsService.hydrate(instance, messages),
			messageReactionsService.hydrate(instance, messages, domain),
			failedIds.length ? prismaService.operatorOutboundSend.findMany({
				where: { instance, messageId: { in: failedIds }, status: { in: ["FAILED", "UNKNOWN"] } },
				select: { messageId: true, status: true, error: true },
			}) : [],
			// No query unless an internal message is in ERROR.
			domain === "internal" ? internalRetryHints(instance, messages) : new Map<number, WhatsappRetryHint>(),
		]);
		const attemptsByMessage = new Map(attempts.map((attempt) => [attempt.messageId, attempt]));
		return reactions.map((message, index) => {
			const { mentionMetadata: _storedMetadata, mentionEntities: _previousEntities, ...rest } = message;
			const resolved = mentions[index]?.mentionEntities;
			const retry = retryHints.get(message.id);
			return { ...rest, ...sendError(message, attemptsByMessage.get(message.id)),
				...(resolved === undefined ? {} : { mentionEntities: resolved }),
				...(retry ? { whatsappRetry: retry } : {}) };
		});
	}
}

export default new MessagePresentationService();
