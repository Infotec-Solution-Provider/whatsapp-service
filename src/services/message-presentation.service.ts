import messageMentionsService from "./message-mentions.service";
import messageReactionsService from "./message-reactions.service";
import type { MentionEntity } from "../utils/message-mention-metadata";
import { normalizeMentionEntities } from "../utils/message-mention-metadata";
import type { MessageReactionSnapshot } from "./message-reactions.types";
import prismaService from "./prisma.service";

type PresentableMessage = {
	id: number; instance: string; clientId?: number | null; internalChatId?: number;
	wwebjsId?: string | null; wwebjsIdStanza?: string | null; wabaId?: string | null; gupshupId?: string | null;
	mentionMetadata?: unknown; mentionEntities?: unknown;
	status?: string;
};

type SendAttemptError = { status: string; error: string | null };
type SendErrorPresentation = { sendError?: string | null };

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
		Promise<Array<Omit<T & MessageReactionSnapshot, "mentionMetadata" | "mentionEntities"> & { mentionEntities?: MentionEntity[] } & SendErrorPresentation>> {
		// Successful/pending and internal messages need no outbound-attempt query.
		const failedIds = domain === "wpp" ? messages.filter((message) => message.instance === instance
			&& (message.status === "ERROR" || message.status === "UNKNOWN")).map((message) => message.id) : [];
		const [mentions, reactions, attempts] = await Promise.all([
			messageMentionsService.hydrate(instance, messages),
			messageReactionsService.hydrate(instance, messages, domain),
			failedIds.length ? prismaService.operatorOutboundSend.findMany({
				where: { instance, messageId: { in: failedIds }, status: { in: ["FAILED", "UNKNOWN"] } },
				select: { messageId: true, status: true, error: true },
			}) : [],
		]);
		const attemptsByMessage = new Map(attempts.map((attempt) => [attempt.messageId, attempt]));
		return reactions.map((message, index) => {
			const { mentionMetadata: _storedMetadata, mentionEntities: _previousEntities, ...rest } = message;
			const resolved = mentions[index]?.mentionEntities;
			return { ...rest, ...sendError(message, attemptsByMessage.get(message.id)),
				...(resolved === undefined ? {} : { mentionEntities: resolved }) };
		});
	}
}

export default new MessagePresentationService();
