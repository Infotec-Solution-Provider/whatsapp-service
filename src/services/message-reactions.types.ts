import type { MessageReaction } from "@prisma/client";

export interface MessageReactionScope {
	instance: string;
	clientId: number;
	targetMessageId: string;
}

export interface ApplyMessageReactionInput extends MessageReactionScope {
	actorId: string;
	fromMe: boolean;
	/** Empty string removes this actor's reaction while retaining its timestamp. */
	emoji: string;
	/** Provider event time, not the target message time. */
	reactedAt: Date;
	receivedAt?: Date;
	sourceEventId?: string | null;
	/** Supplied only by the authenticated send flow, never by provider webhooks. */
	internalUserId?: number | null;
	internalUserName?: string | null;
}

export interface ApplyMessageReactionResult {
	applied: boolean;
	reaction: MessageReaction;
}

export interface ReactionView {
	actorId: string;
	emoji: string;
	fromMe: boolean;
	reactedAt: string;
	sourceEventId?: string;
	internalUserId?: number;
	internalUserName?: string | null;
}

export interface MessageReactionSnapshot {
	reactions: ReactionView[];
	/** Includes removals, allowing clients to reject older HTTP snapshots. */
	reactionsUpdatedAt: string | null;
}

export interface MessageReactionReference {
	domain: "WPP" | "INTERNAL";
	messageId: number;
	clientId: number | null;
	targetMessageIds: readonly string[];
}

export function messageReactionReferenceKey(reference: Pick<MessageReactionReference, "domain" | "messageId">): string {
	return `${reference.domain}:${reference.messageId}`;
}

/** Equal timestamps cannot establish order; a removal wins and remains stable. */
export function isNewerMessageReaction(
	incoming: Pick<MessageReaction, "reactedAt" | "emoji">,
	current: Pick<MessageReaction, "reactedAt" | "emoji">,
): boolean {
	const difference = incoming.reactedAt.getTime() - current.reactedAt.getTime();
	return difference > 0 || (difference === 0 && incoming.emoji === "" && current.emoji !== "");
}
