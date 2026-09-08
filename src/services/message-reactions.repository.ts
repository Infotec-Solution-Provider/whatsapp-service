import { MessageReaction, Prisma, PrismaClient } from "@prisma/client";
import prismaService from "./prisma.service";
import {
	ApplyMessageReactionInput,
	ApplyMessageReactionResult,
	isNewerMessageReaction,
	messageReactionReferenceKey,
	MessageReactionReference,
	MessageReactionScope,
	MessageReactionSnapshot,
} from "./message-reactions.types";

export * from "./message-reactions.types";

export class MessageReactionsRepository {
	constructor(private readonly db: PrismaClient = prismaService) {}

	async apply(input: ApplyMessageReactionInput): Promise<ApplyMessageReactionResult> {
		const actorId = input.fromMe ? "self" : input.actorId;
		const identity = {
			instance: input.instance, clientId: input.clientId,
			targetMessageId: input.targetMessageId, actorId,
		};
		const where = { instance_clientId_targetMessageId_actorId: identity };
		const data = {
			...identity, fromMe: input.fromMe, emoji: input.emoji, reactedAt: input.reactedAt,
			receivedAt: input.receivedAt ?? new Date(), sourceEventId: input.sourceEventId ?? null,
		};
		let existing = await this.db.messageReaction.findUnique({ where });
		if (!existing) {
			try {
				return { applied: true, reaction: await this.db.messageReaction.create({ data }) };
			} catch (error) {
				if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
				// A concurrent first event won the unique key; compare timestamps below.
				existing = await this.db.messageReaction.findUnique({ where });
				if (!existing) throw error;
			}
		}
		if (!isNewerMessageReaction(input, existing)) return { applied: false, reaction: existing };
		// The temporal predicate is evaluated by the UPDATE itself, not by a stale
		// application snapshot. A later reaction racing this call cannot regress.
		const updated = await this.db.messageReaction.updateMany({
			where: {
				...identity,
				OR: [
					{ reactedAt: { lt: input.reactedAt } },
					...(input.emoji === "" ? [{ reactedAt: input.reactedAt, emoji: { not: "" } }] : []),
				],
			},
			data,
		});
		return { applied: updated.count === 1, reaction: await this.db.messageReaction.findUniqueOrThrow({ where }) };
	}

	async listForTarget(scope: MessageReactionScope, includeRemoved = false): Promise<MessageReaction[]> {
		return this.db.messageReaction.findMany({
			where: {
				instance: scope.instance, clientId: scope.clientId, targetMessageId: scope.targetMessageId,
				...(includeRemoved ? {} : { emoji: { not: "" } }),
			},
			orderBy: [{ reactedAt: "asc" }, { actorId: "asc" }],
		});
	}

	async hydrate(instance: string, references: readonly MessageReactionReference[]): Promise<Map<string, MessageReactionSnapshot>> {
		const snapshots = new Map<string, MessageReactionSnapshot>();
		const targets = new Map<string, { clientId: number; targetMessageId: string }>();
		for (const reference of references) {
			snapshots.set(messageReactionReferenceKey(reference), { reactions: [], reactionsUpdatedAt: null });
			if (reference.clientId === null) continue;
			for (const targetMessageId of reference.targetMessageIds.filter(Boolean)) {
				targets.set(JSON.stringify([reference.clientId, targetMessageId]), { clientId: reference.clientId, targetMessageId });
			}
		}
		if (!targets.size) return snapshots;
		const rows: MessageReaction[] = [];
		const uniqueTargets = [...targets.values()];
		// Bound query size for exports/history loads; never issue one query per message.
		for (let offset = 0; offset < uniqueTargets.length; offset += 200) {
			rows.push(...await this.db.messageReaction.findMany({
				where: { instance, OR: uniqueTargets.slice(offset, offset + 200) },
				orderBy: [{ reactedAt: "asc" }, { actorId: "asc" }],
			}));
		}
		const byTarget = new Map<string, MessageReaction[]>();
		for (const row of rows) {
			const key = JSON.stringify([row.clientId, row.targetMessageId]);
			const list = byTarget.get(key) ?? [];
			list.push(row);
			byTarget.set(key, list);
		}
		for (const reference of references) {
			const actors = new Map<string, MessageReaction>();
			let latest: number | null = null;
			for (const targetMessageId of reference.targetMessageIds) {
				for (const row of byTarget.get(JSON.stringify([reference.clientId, targetMessageId])) ?? []) {
					latest = Math.max(latest ?? -Infinity, row.reactedAt.getTime());
					const current = actors.get(row.actorId);
					if (!current || isNewerMessageReaction(row, current)) actors.set(row.actorId, row);
				}
			}
			snapshots.set(messageReactionReferenceKey(reference), {
				reactions: [...actors.values()].filter((row) => row.emoji !== "")
					.sort((a, b) => a.reactedAt.getTime() - b.reactedAt.getTime() || a.actorId.localeCompare(b.actorId))
					.map((row) => ({ actorId: row.actorId, emoji: row.emoji, fromMe: row.fromMe, reactedAt: row.reactedAt.toISOString() })),
				reactionsUpdatedAt: latest !== null ? new Date(latest).toISOString() : null,
			});
		}
		return snapshots;
	}
}

export default new MessageReactionsRepository();
