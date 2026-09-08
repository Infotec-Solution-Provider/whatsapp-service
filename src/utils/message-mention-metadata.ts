import { Prisma } from "@prisma/client";

// The operator accepts 100 selected mentions, each with a user token and a PN token.
// Remote providers independently cap their protocol mention list at 100 people.
export const MAX_MENTION_ENTITIES = 200;
const MAX_MENTION_TOKENS = 16;

export interface MentionEntity {
	id: string;
	type: "lid" | "phone" | "user";
	tokens: string[];
	phone?: string | null;
	lid?: string | null;
	displayName?: string | null;
}

/** Accept phone formatting only when the field explicitly represents a phone. */
export function normalizeMentionPhone(value: unknown): string | null {
	if (typeof value !== "string" || !/^[+()\d .-]+$/.test(value)) return null;
	const digits = value.replace(/\D/g, "");
	return /^\d{6,15}$/.test(digits) ? digits : null;
}

export function normalizeMentionLid(value: unknown): string | null {
	return typeof value === "string" ? /^(\d{1,30})(?:@lid)?$/i.exec(value.trim())?.[1] ?? null : null;
}

export function normalizeMentionDisplayName(value: unknown, identity?: string): string | null {
	if (typeof value !== "string") return null;
	const name = value.trim();
	if (!name || name === identity || /[\u0000-\u001f\u007f]/u.test(name) ||
		/^[+() .-]*\d[\d+() .-]*$/.test(name) || /^@?~?\d+$/.test(name) ||
		/@(?:c\.us|g\.us|lid|s\.whatsapp\.net)$/i.test(name) ||
		/^(?:undefined|null|unknown|desconhecido|sem nome)$/i.test(name)) return null;
	return Array.from(name).slice(0, 191).join("");
}

function identity(value: unknown, declaredType: unknown): Pick<MentionEntity, "id" | "type"> | null {
	if (typeof value !== "string") return null;
	const raw = value.trim();
	if (declaredType === "user") {
		const numeric = /^(?:user:)?([1-9]\d*)$/.exec(raw)?.[1];
		if (!numeric || !Number.isSafeInteger(Number(numeric))) return null;
		return { id: `user:${numeric}`, type: "user" };
	}
	const matched = /^(\d+)(?::\d+)?@(lid|c\.us|s\.whatsapp\.net)$/i.exec(raw);
	if (!matched) return null;
	const digits = matched[1]!;
	const type = matched[2]!.toLowerCase() === "lid" ? "lid" : "phone";
	if (declaredType !== undefined && declaredType !== type) return null;
	if (type === "lid" ? digits.length > 30 : normalizeMentionPhone(digits) === null) return null;
	return { id: `${digits}@${type === "lid" ? "lid" : "s.whatsapp.net"}`, type };
}

/** Provider aliases are explicit JIDs; numeric LID digits never create PN aliases. */
export function mentionEntityIdentifiers(entity: MentionEntity): string[] {
	if (entity.type === "user") return [];
	const aliases = [entity.id];
	if (entity.lid) aliases.push(`${entity.lid}@lid`);
	if (entity.type === "phone" || entity.phone) {
		const phone = entity.type === "phone" ? entity.id.split("@")[0]! : normalizeMentionPhone(entity.phone);
		if (phone) aliases.push(`${phone}@s.whatsapp.net`, `${phone}@c.us`);
	}
	return [...new Set(aliases)];
}

function tokensFor(entity: MentionEntity, rawTokens: unknown): string[] {
	if (entity.type === "user") return [`@~${entity.id.slice("user:".length)}`];
	const identifiers = mentionEntityIdentifiers(entity);
	const bare = new Set(identifiers.map((id) => id.split("@")[0]!));
	const tokens = new Set([...bare].map((part) => `@${part}`));
	for (const id of identifiers) tokens.add(`@${id}`);
	if (Array.isArray(rawTokens)) {
		for (const token of rawTokens.slice(0, MAX_MENTION_TOKENS)) {
			if (typeof token !== "string" || token.length > 191) continue;
			// Older transports use @~ for provider mentions too. Accept it only
			// when explicitly attached to this typed, confirmed provider identity.
			if (token.startsWith("@~") && bare.has(token.slice(2))) tokens.add(token);
			if (token.startsWith("@")) {
				const alias = identity(token.slice(1), undefined);
				if (alias && identifiers.includes(alias.id)) tokens.add(token);
			}
		}
	}
	return [...tokens].slice(0, MAX_MENTION_TOKENS);
}

export function normalizeMentionEntities(value: unknown): MentionEntity[] {
	if (!Array.isArray(value)) return [];
	const entities = new Map<string, MentionEntity>();
	const conflictingPhones = new Set<string>();
	const conflictingLids = new Set<string>();
	for (const raw of value.slice(0, MAX_MENTION_ENTITIES)) {
		const source = typeof raw === "string" ? { id: raw } : raw;
		if (!source || typeof source !== "object" || Array.isArray(source)) continue;
		const record = source as Record<string, unknown>;
		const resolved = identity(record["id"], record["type"]);
		if (!resolved) continue;
		const phone = resolved.type === "phone" ? resolved.id.split("@")[0]!
			: resolved.type === "lid" ? normalizeMentionPhone(record["phone"]) : null;
		const entity: MentionEntity = {
			...resolved, phone,
			lid: resolved.type === "lid" ? resolved.id.split("@")[0]! : resolved.type === "phone" ? normalizeMentionLid(record["lid"]) : null,
			displayName: normalizeMentionDisplayName(record["displayName"], resolved.id), tokens: [],
		};
		entity.tokens = tokensFor(entity, record["tokens"]);
		const previous = entities.get(entity.id);
		if (previous) {
			const merged: MentionEntity = {
				...previous, phone: previous.phone ?? entity.phone ?? null,
				lid: previous.lid ?? entity.lid ?? null,
				displayName: previous.displayName ?? entity.displayName ?? null,
			};
			// Conflicting explicit mappings do not establish a phone alias for a LID.
			if (entity.type === "lid" && previous.phone && entity.phone && previous.phone !== entity.phone) conflictingPhones.add(entity.id);
			if (conflictingPhones.has(entity.id)) merged.phone = null;
			if (entity.type === "phone" && previous.lid && entity.lid && previous.lid !== entity.lid) conflictingLids.add(entity.id);
			if (conflictingLids.has(entity.id)) merged.lid = null;
			merged.tokens = tokensFor(merged, [...previous.tokens, ...entity.tokens]);
			entities.set(entity.id, merged);
		} else entities.set(entity.id, entity);
	}
	return [...entities.values()];
}

export function mentionMetadataToPrisma(value: unknown): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
	return value == null ? Prisma.DbNull : JSON.parse(JSON.stringify(normalizeMentionEntities(value))) as Prisma.InputJsonValue;
}
