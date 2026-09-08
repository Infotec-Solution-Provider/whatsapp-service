import type { PrismaClient } from "@prisma/client";
import { Logger } from "@in.pulse-crm/utils";
import prismaService from "./prisma.service";
import {
	MentionEntity,
	mentionEntityIdentifiers,
	normalizeMentionDisplayName,
	normalizeMentionEntities,
	normalizeMentionLid,
	normalizeMentionPhone,
} from "../utils/message-mention-metadata";

export type { MentionEntity } from "../utils/message-mention-metadata";

interface MentionMessage {
	instance: string;
	internalChatId?: number | null;
	mentionMetadata?: unknown;
	mentionEntities?: unknown;
}

interface ContactName {
	id: number;
	instance: string;
	whatsappId: string | null;
	phone: string | null;
	name: string;
}

interface SenderName {
	instance: string;
	senderId: string;
	displayName: string | null;
	isManuallyNamed: boolean;
	messages: Array<{ internalChatId: number }>;
}

const BATCH_SIZE = 500;

function chunks<T>(values: T[]): T[][] {
	const result: T[][] = [];
	for (let offset = 0; offset < values.length; offset += BATCH_SIZE) result.push(values.slice(offset, offset + BATCH_SIZE));
	return result;
}

export class MessageMentionsService {
	constructor(private readonly db: PrismaClient = prismaService) {}

	async hydrate<T extends MentionMessage>(instance: string, messages: T[]): Promise<Array<T & { mentionEntities?: MentionEntity[] }>> {
		const hydrated: Array<T & { mentionEntities?: MentionEntity[] }> = [];
		for (const batch of chunks(messages)) {
			try { hydrated.push(...await this.hydrateBatch(instance, batch)); }
			catch (error) {
				Logger.error("[MessageMentions] Name lookup unavailable; retaining normalized stored identities", error as Error);
				// Name enrichment is optional. A lookup outage cannot turn a message
				// already persisted into a failed receive/send operation.
				hydrated.push(...batch.map((message) => {
					const { mentionEntities: _provided, ...rest } = message;
					if (message.mentionMetadata == null && message.mentionEntities == null) return rest as T & { mentionEntities?: MentionEntity[] };
					return { ...rest, mentionEntities: message.instance === instance
						? normalizeMentionEntities(message.mentionMetadata ?? message.mentionEntities) : [] } as T & { mentionEntities?: MentionEntity[] };
				}));
			}
		}
		return hydrated;
	}

	private async hydrateBatch<T extends MentionMessage>(instance: string, messages: T[]): Promise<Array<T & { mentionEntities?: MentionEntity[] }>> {
		const values = messages.map((message) => {
			const explicit = message.mentionMetadata != null || message.mentionEntities != null;
			return {
				message, explicit,
				entities: message.instance === instance && explicit ? normalizeMentionEntities(message.mentionMetadata ?? message.mentionEntities) : [],
			};
		});
		const entities = new Map<string, MentionEntity>();
		const internalEntityIds = new Set<string>();
		const internalChatIds = new Set<number>();
		for (const value of values) {
			for (const entity of value.entities) {
				if (entity.type === "user") continue;
				const previous = entities.get(entity.id);
				entities.set(entity.id, previous ? normalizeMentionEntities([previous, entity])[0]! : entity);
				if (Number.isSafeInteger(value.message.internalChatId) && Number(value.message.internalChatId) > 0) {
					internalEntityIds.add(entity.id);
					internalChatIds.add(value.message.internalChatId!);
				}
			}
		}

		const whatsappIds = new Set<string>();
		const phones = new Set<string>();
		const contactBareOwners = new Map<string, Set<string>>();
		for (const entity of values.flatMap((value) => value.entities).filter((entity) => entity.type !== "user")) {
			for (const id of mentionEntityIdentifiers(entity)) whatsappIds.add(id);
			if (entity.phone) phones.add(entity.phone);
			const bare = entity.id.split("@")[0]!;
			const owners = contactBareOwners.get(bare) ?? new Set<string>();
			owners.add(entity.id); contactBareOwners.set(bare, owners);
		}
		for (const [bare, owners] of contactBareOwners) if (owners.size === 1) whatsappIds.add(bare);
		const contactIds = chunks([...whatsappIds]);
		const contactPhones = chunks([...phones]);
		const contacts = new Map<number, ContactName>();
		for (let index = 0; index < Math.max(contactIds.length, contactPhones.length); index++) {
			const found = await this.db.wppContact.findMany({
				where: { instance, isDeleted: false, OR: [
					...(contactIds[index]?.length ? [{ whatsappId: { in: contactIds[index]! } }] : []),
					...(contactPhones[index]?.length ? [{ phone: { in: contactPhones[index]! } }] : []),
				] },
				select: { id: true, instance: true, whatsappId: true, phone: true, name: true },
			});
			for (const contact of found) if (contact.instance === instance) contacts.set(contact.id, contact);
		}
		const byId = new Map<string, ContactName>();
		const byPhone = new Map<string, ContactName>();
		const byBareId = new Map<string, ContactName>();
		for (const contact of [...contacts.values()].sort((a, b) => a.id - b.id)) {
			const contactId = normalizeMentionEntities([contact.whatsappId])[0]?.id;
			if (contactId && !byId.has(contactId)) byId.set(contactId, contact);
			if (contact.whatsappId && /^\d+$/.test(contact.whatsappId) && !byBareId.has(contact.whatsappId)) byBareId.set(contact.whatsappId, contact);
			const phone = normalizeMentionPhone(contact.phone);
			if (phone && !byPhone.has(phone)) byPhone.set(phone, contact);
		}
		const resolve = (entity: MentionEntity) => {
			const bare = entity.id.split("@")[0]!;
			const historical = contactBareOwners.get(bare)?.size === 1 ? byBareId.get(bare) : undefined;
			const historicalPhone = normalizeMentionPhone(historical?.phone);
			// A bare contact whose phone equals its ID is evidence of PN, not LID.
			// Unknown legacy bare IDs are usable only for the explicitly typed LID.
			const compatibleHistorical = entity.type === "lid" ? historicalPhone !== bare : historicalPhone === bare;
			const exact = byId.get(entity.id) ?? (compatibleHistorical ? historical : undefined);
			const confirmedAlias = mentionEntityIdentifiers(entity).map((id) => byId.get(id)).find((candidate) => candidate !== undefined);
			const contact = exact ?? confirmedAlias ?? (entity.phone ? byPhone.get(entity.phone) : undefined);
			// Only an explicit contact mapping for this LID may contribute a phone.
			// Its numeric identifier by itself is never a telephone lookup key.
			const phone = entity.type === "lid" && exact ? normalizeMentionPhone(exact.phone) ?? entity.phone ?? null : entity.phone ?? null;
			const confirmedLid = entity.type === "phone" && entity.phone && normalizeMentionPhone(contact?.phone) === entity.phone && contact?.whatsappId?.endsWith("@lid")
				? normalizeMentionLid(contact.whatsappId) : null;
			return {
				entity: normalizeMentionEntities([{ ...entity, phone, lid: confirmedLid ?? entity.lid ?? null }])[0]!,
				contactName: normalizeMentionDisplayName(contact?.name, entity.id),
				confirmedPhone: entity.type === "lid" && exact ? normalizeMentionPhone(exact.phone) : null,
				confirmedLid,
			};
		};

		const aliases = new Map<string, string[]>();
		const bareOwners = new Map<string, Set<string>>();
		for (const id of internalEntityIds) {
			const entity = resolve(entities.get(id)!).entity;
			const full = mentionEntityIdentifiers(entity);
			aliases.set(id, full);
			for (const jid of full) {
				const bare = jid.split("@")[0]!;
				const owners = bareOwners.get(bare) ?? new Set<string>();
				owners.add(id); bareOwners.set(bare, owners);
			}
		}
		for (const [id, full] of aliases) {
			// Historical bare sender IDs are usable only when unambiguous in this
			// typed batch. They never establish a PN/LID mapping or a phone alias.
			aliases.set(id, [...full, ...new Set(full.map((jid) => jid.split("@")[0]!).filter((bare) => bareOwners.get(bare)?.size === 1))]);
		}
		const senderIds = [...new Set([...aliases.values()].flat())];
		const senders = new Map<string, SenderName>();
		if (internalChatIds.size) {
			const allowedChats = [...internalChatIds];
			for (const ids of chunks(senderIds)) {
				const found = await this.db.internalWhatsappSender.findMany({
					where: { instance, senderId: { in: ids }, messages: { some: { instance, internalChatId: { in: allowedChats } } } },
					select: { instance: true, senderId: true, displayName: true, isManuallyNamed: true,
						messages: { where: { instance, internalChatId: { in: allowedChats } }, select: { internalChatId: true }, distinct: ["internalChatId"] },
					},
				});
				for (const sender of found) if (sender.instance === instance) senders.set(sender.senderId, sender);
			}
		}

		return values.map(({ message, explicit, entities: messageEntities }) => {
			if (!explicit) {
				const { mentionEntities: _legacyEmpty, ...rest } = message;
				return rest as T & { mentionEntities?: MentionEntity[] };
			}
			const mentionEntities = messageEntities.map((original) => {
				if (original.type === "user") return original;
				const resolved = resolve(original);
				const ownFullIds = mentionEntityIdentifiers(resolved.entity);
				const ownAliases = new Set([...ownFullIds, ...ownFullIds.map((id) => id.split("@")[0]!)]);
				const permitted = (aliases.get(original.id) ?? []).filter((id) => ownAliases.has(id)).map((id) => senders.get(id))
					.filter((sender): sender is SenderName => !!sender && sender.messages.some((m) => m.internalChatId === message.internalChatId));
				const nameOf = (manual: boolean) => permitted.filter((sender) => sender.isManuallyNamed === manual)
					.map((sender) => normalizeMentionDisplayName(sender.displayName, sender.senderId)).find((name) => name !== null);
				// Token spelling belongs to the individual message; do not copy it
				// from another message mentioning the same provider identity.
				return normalizeMentionEntities([{ ...original, phone: resolved.confirmedPhone ?? original.phone ?? null,
					lid: resolved.confirmedLid ?? original.lid ?? null,
					displayName: nameOf(true) ?? resolved.contactName ?? nameOf(false) ?? original.displayName ?? null,
				}])[0]!;
			});
			return { ...message, mentionEntities };
		});
	}
}

export default new MessageMentionsService();
