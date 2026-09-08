import messageMentionsService from "./message-mentions.service";
import messageReactionsService from "./message-reactions.service";
import type { MentionEntity } from "../utils/message-mention-metadata";
import { normalizeMentionEntities } from "../utils/message-mention-metadata";
import type { MessageReactionSnapshot } from "./message-reactions.types";

type PresentableMessage = {
	id: number; instance: string; clientId?: number | null; internalChatId?: number;
	wwebjsId?: string | null; wwebjsIdStanza?: string | null; wabaId?: string | null; gupshupId?: string | null;
	mentionMetadata?: unknown; mentionEntities?: unknown;
};

/** Batch both enrichments without changing the persisted message body. */
class MessagePresentationService {
	/** Mutation responses need no extra database work after a send was accepted. */
	fromStored<T extends { mentionMetadata?: unknown; mentionEntities?: unknown }>(message: T):
		Omit<T, "mentionMetadata" | "mentionEntities"> & { mentionEntities?: MentionEntity[] } {
		const { mentionMetadata, mentionEntities, ...rest } = message;
		// A hydrated DTO contains current names; the stored snapshot is its fallback.
		const value = mentionEntities ?? mentionMetadata;
		return value == null ? rest : { ...rest, mentionEntities: normalizeMentionEntities(value) };
	}

	async hydrate<T extends PresentableMessage>(instance: string, messages: T[], domain: "wpp" | "internal" = "wpp"):
		Promise<Array<Omit<T & MessageReactionSnapshot, "mentionMetadata" | "mentionEntities"> & { mentionEntities?: MentionEntity[] }>> {
		const [mentions, reactions] = await Promise.all([
			messageMentionsService.hydrate(instance, messages),
			messageReactionsService.hydrate(instance, messages, domain),
		]);
		return reactions.map((message, index) => {
			const { mentionMetadata: _storedMetadata, mentionEntities: _previousEntities, ...rest } = message;
			const resolved = mentions[index]?.mentionEntities;
			return resolved === undefined ? rest : { ...rest, mentionEntities: resolved };
		});
	}
}

export default new MessagePresentationService();
