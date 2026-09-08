import { Prisma } from "@prisma/client";
import { mentionMetadataToPrisma, normalizeMentionEntities, normalizeMentionPhone, type MentionEntity } from "./message-mention-metadata";

interface MentionMessageInput {
	body?: string | null;
	mentionEntities?: unknown;
	mentionMetadata?: unknown;
}

/** A status-only update preserves mentions. An old-client body edit cannot keep stale identities. */
export function messageMentionPatch(input: MentionMessageInput, previous?: { body?: string | null }) {
	if (input.mentionEntities !== undefined) return { mentionMetadata: mentionMetadataToPrisma(input.mentionEntities) };
	if (input.mentionMetadata !== undefined) return { mentionMetadata: mentionMetadataToPrisma(input.mentionMetadata) };
	if (previous && input.body !== undefined && input.body !== previous.body) return { mentionMetadata: Prisma.DbNull };
	return {};
}

export function mentionEntitiesFromJids(jids: readonly string[]): MentionEntity[];
export function mentionEntitiesFromJids(jids: readonly string[] | undefined): MentionEntity[] | undefined;
export function mentionEntitiesFromJids(jids: readonly string[] | undefined): MentionEntity[] | undefined {
	if (jids === undefined) return undefined;
	return normalizeMentionEntities(jids.map((id) => ({ id, tokens: [`@~${id.split("@")[0]?.split(":")[0]}`] })));
}

/** Internal user codes and provider phone identities remain separate namespaces. */
export function operatorMentionEntities(mentions: readonly unknown[]): MentionEntity[] {
	const entities: unknown[] = [];
	for (const value of mentions.slice(0, 100)) {
		if (!value || typeof value !== "object") continue;
		const mention = value as Record<string, unknown>;
		if (Number.isSafeInteger(mention["userId"]) && Number(mention["userId"]) > 0) {
			entities.push({ id: `user:${mention["userId"]}`, type: "user", displayName: mention["name"] });
		}
		const phone = normalizeMentionPhone(mention["phone"]);
		if (phone) entities.push({ id: `${phone}@s.whatsapp.net`, type: "phone", displayName: mention["name"] });
	}
	return normalizeMentionEntities(entities);
}
