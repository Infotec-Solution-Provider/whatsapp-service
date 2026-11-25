import { createHash } from "node:crypto";
import type { Prisma, WppChat, WppContact, WppMessage } from "@prisma/client";
import db from "../services/prisma.service";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { triageAuthoring } from "./authoring";
import { triageTriggers } from "./triggers";
import { advanceTriage } from "./engine";
import {
	acceptsTriageMessage,
	lockSession,
	openChatForChannel,
	recordTurn,
	triageJson,
	TRIAGE_CHAT_MARKER
} from "./runtime";

type Tx = Prisma.TransactionClient;
type Trigger = "keyword" | "manual" | "transfer" | "closed" | "flow";
interface StartInput {
	instance: string;
	channelId: number;
	chatId?: number;
	type: Trigger;
	eventKey: string;
	actorId?: number;
	sectorId?: number;
	message?: WppMessage;
	contact?: WppContact;
	botId?: number;
	expectedVersion?: number;
	expectedMessage?: number;
	expectedUserId?: number | null;
	resultId?: number;
	// Used only when the multidepartment menu gives control to the chosen sector.
	fromSectorMenu?: boolean;
	authorizeTx?: (tx: Tx) => Promise<void>;
}
function triggerKey(input: StartInput) {
	if (input.message && (input.type === "keyword" || input.type === "flow")) return "message:" + input.message.id;
	return (
		input.type +
		":" +
		createHash("sha256")
			.update(JSON.stringify([input.channelId, input.chatId, input.eventKey]))
			.digest("hex")
	);
}

/** Use an actual inbound on this conversation, never the sector's default sending number. */
export async function latestTriageInbound(tx: Tx, instance: string, chatId: number) {
	const [row] = await tx.$queryRawUnsafe<{ id: number }[]>(
		"SELECT id FROM messages WHERE instance=? AND chat_id=? AND client_id IS NOT NULL AND agent_id IS NULL " +
			"AND `from`<>'' AND `from` NOT REGEXP '^(bot:|system|thirdparty:|user:|me:)|@(g[.]us|broadcast|newsletter)$' " +
			"AND type NOT REGEXP '^(system|thirdparty|reaction|revoked|protocol|ciphertext|notification|call_log)(:|$)' ORDER BY id DESC LIMIT 1",
		instance,
		chatId
	);
	return row ? tx.wppMessage.findFirst({ where: { id: row.id, instance, chatId } }) : null;
}
function available(chat: WppChat, input: Pick<StartInput, "type" | "actorId" | "fromSectorMenu">) {
	if (input.type === "closed") return chat.isFinished;
	if (chat.isFinished || chat.agentId != null) return false;
	if (input.fromSectorMenu) return chat.botId === 1 && !chat.userId;
	return (
		chat.botId == null && ((chat.userId ?? 0) <= 0 || (input.type === "manual" && chat.userId === input.actorId))
	);
}
function withinWindow(channelType: string, source: WppMessage) {
	return !["WABA", "GUPSHUP"].includes(channelType) || Date.now() - source.sentAt.getTime() < 24 * 60 * 60 * 1000;
}
async function manualTarget(tx: Tx, instance: string, channelId: number, chat: WppChat, actorId: number) {
	if (!chat.sectorId || !available(chat, { type: "manual", actorId })) return [];
	const source = await latestTriageInbound(tx, instance, chat.id);
	const channel = await tx.wppClient.findFirst({
		where: { instance, id: channelId, isActive: true },
		select: { type: true }
	});
	if (!channel || !source || !withinWindow(channel.type, source)) return [];
	const session = await tx.triageSession.findFirst({ where: { instance, chatId: chat.id } });
	if (
		session &&
		(session.channelId !== channelId ||
			["waiting", "handoff"].includes(session.status) ||
			(await tx.triageEffect.findFirst({
				where: { instance, chatId: chat.id, status: { in: ["pending", "working", "sending"] } },
				select: { id: true }
			})))
	)
		return [];
	if (!source || source.clientId !== channelId) return [];
	return (await triageTriggers.manualOptions(instance, channelId, chat.sectorId, tx)).map(
		({ botId, channelId, name, version }) => ({ botId, channelId, name, version })
	);
}
export async function manualTriageAvailability(instance: string, channelId: number, chatId: number, actorId: number) {
	return withDatabaseTenant(instance, () =>
		db.$transaction(
			async (tx) => {
				const chat = await tx.wppChat.findFirst({ where: { instance, id: chatId } });
				return chat ? manualTarget(tx, instance, channelId, chat, actorId) : [];
			},
			{ isolationLevel: "ReadCommitted" }
		)
	);
}

export async function startTriggeredTriage(input: StartInput) {
	const { instance, channelId } = input;
	if (
		input.message &&
		(!acceptsTriageMessage(input.message) ||
			input.message.instance !== instance ||
			input.message.clientId !== channelId)
	)
		return null;
	if (input.type === "keyword" && (!input.message || !["text", "chat"].includes(input.message.type))) return null;
	const key = triggerKey(input);
	return withDatabaseTenant(instance, () =>
		db.$transaction(
			async (tx) => {
				if (input.authorizeTx) await input.authorizeTx(tx);
				// Serialize publication, pause and repeated delivery before consulting the idempotency record.
				await tx.$queryRawUnsafe(
					"SELECT id FROM clients WHERE instance=? AND id=? FOR UPDATE",
					instance,
					channelId
				);
				const prior = await tx.triageRun.findFirst({ where: { instance, eventKey: key } });
				if (prior) {
					if (
						prior.channelId !== channelId ||
						(input.botId != null && prior.botId !== input.botId) ||
						(input.type === "manual" && prior.actorId !== input.actorId)
					)
						return null;
					const v = await triageAuthoring.getBotRuntimeVersion(instance, prior.botId, prior.versionId, tx);
					if (!v || v.channelId !== channelId) throw new Error("TRIAGE_ORIGINAL_VERSION_MISSING");
					const chat = await tx.wppChat.findFirstOrThrow({ where: { instance, id: prior.chatId } });
					return {
						chat,
						started: false,
						opened: false,
						ref: { id: prior.botId, name: v.name, version: v.version }
					};
				}
				// Contact serializes two simultaneous first messages and starts racing a post-close follow-up.
				const original = input.chatId
					? await tx.wppChat.findFirst({ where: { instance, id: input.chatId } })
					: null;
				const contactId = input.contact?.id ?? original?.contactId;
				if (!contactId || (input.chatId && !original) || (input.contact && input.contact.instance !== instance))
					return null;
				await tx.$queryRawUnsafe(
					"SELECT id FROM contacts WHERE instance=? AND id=? FOR UPDATE",
					instance,
					contactId
				);
				if (original)
					await tx.$queryRawUnsafe(
						"SELECT id FROM chats WHERE instance=? AND id=? FOR UPDATE",
						instance,
						original.id
					);
				let chat = original
					? await tx.wppChat.findFirstOrThrow({ where: { instance, id: original.id } })
					: null;
				const previousInbound = chat ? await latestTriageInbound(tx, instance, chat.id) : null;
				if (previousInbound && previousInbound.clientId !== channelId) return null;
				const source = input.message ?? previousInbound;
				if (
					!source ||
					source.clientId !== channelId ||
					(source.contactId && source.contactId !== contactId) ||
					(input.expectedMessage && source.id !== input.expectedMessage && input.type === "closed")
				)
					return null;
				if (
					chat &&
					(chat.contactId !== contactId ||
						!available(chat, input) ||
						(input.expectedUserId !== undefined && chat.userId !== input.expectedUserId))
				)
					return null;
				if (chat && input.sectorId && !input.fromSectorMenu && chat.sectorId !== input.sectorId) return null;
				const sector = input.sectorId ?? chat?.sectorId ?? undefined;
				const rule =
					input.type === "flow"
						? null
						: await triageTriggers.match(
								instance,
								channelId,
								{
									type: input.type,
									...(input.type === "manual" && input.botId != null && { botId: input.botId }),
									...(sector ? { sectorId: sector } : {}),
									...(input.type === "keyword" ? { text: source.body } : {})
								},
								tx
							);
				const botId = input.type === "flow" ? input.botId : rule?.botId;
				if (
					!botId ||
					(input.botId != null && input.botId !== botId) ||
					(input.type === "manual" && input.botId == null)
				)
					return null;
				const binding = await triageAuthoring.activeForBot(instance, channelId, botId, tx);
				if (
					!binding ||
					(rule && rule.versionId !== binding.versionId) ||
					(input.expectedVersion && input.expectedVersion !== binding.versionId)
				)
					return null;
				const ref = { id: binding.botId, name: binding.name, version: binding.version };
				const sectorId = rule?.sectorId ?? sector;
				const channel = await tx.wppClient.findFirst({
					where: { id: channelId, instance, isActive: true },
					include: { sectors: true }
				});
				const sectors =
					channel?.sectors.filter((s) => s.instance === instance && s.receiveChats).map((s) => s.id) ?? [];
				if (
					!sectorId ||
					!sectors.includes(sectorId) ||
					!sectors.includes(binding.definition.fallbackSectorId ?? 0)
				)
					return null;
				// Follow-ups send ordinary text and may only use a recent customer message on the same official number.
				if (!input.message && (!channel || !withinWindow(channel.type, source))) return null;
				if (!chat || input.type === "closed") {
					const other = await openChatForChannel(tx, instance, contactId, channelId, sectors);
					if (other) return null;
					chat = await tx.wppChat.create({
						data: {
							instance,
							contactId,
							sectorId,
							type: input.type === "closed" ? "ACTIVE" : "RECEPTIVE",
							startedAt: new Date(),
							botId: TRIAGE_CHAT_MARKER
						}
					});
				} else {
					const previous = await lockSession(tx, instance, chat.id);
					if (
						previous &&
						(previous.channelId !== channelId ||
							["waiting", "handoff"].includes(previous.status) ||
							(await tx.triageEffect.findFirst({
								where: { instance, chatId: chat.id, status: { in: ["pending", "working", "sending"] } },
								select: { id: true }
							})))
					)
						return null;
					const changed = await tx.wppChat.updateMany({
						where: {
							id: chat.id,
							instance,
							isFinished: false,
							userId: chat.userId,
							botId: chat.botId,
							agentId: chat.agentId
						},
						data: { botId: TRIAGE_CHAT_MARKER, sectorId, userId: null, agentId: null, walletId: null }
					});
					if (changed.count !== 1) return null;
					chat = await tx.wppChat.findFirstOrThrow({ where: { id: chat.id, instance } });
				}
				const run = await tx.triageRun.create({
					data: {
						instance,
						chatId: chat.id,
						originChatId: original?.id ?? null,
						channelId,
						botId: binding.botId,
						versionId: binding.versionId,
						eventKey: key,
						kind: input.type,
						actorId: input.actorId ?? null
					}
				});
				const event = {
					type: "start" as const,
					...(input.message && !input.fromSectorMenu ? { text: source.body } : {})
				};
				const now = new Date(),
					turn = advanceTriage(binding.definition, null, event, now);
				const data = {
					runId: run.id,
					instance,
					channelId,
					contactId,
					botId: binding.botId,
					versionId: binding.versionId,
					definition: triageJson(binding.definition),
					state: triageJson(turn.state),
					status: "waiting",
					lastMessageId: source.id,
					deadline: null,
					createdAt: now
				};
				const session = await tx.triageSession.upsert({
					where: { chatId: chat.id },
					update: data,
					create: { chatId: chat.id, ...data }
				});
				await recordTurn(tx, session, key, event, turn, source.id);
				if (input.message)
					await tx.wppMessage.update({ where: { id: source.id }, data: { chatId: chat.id, contactId } });
				return { chat, started: true, opened: !original || input.type === "closed", ref };
			},
			{ isolationLevel: "ReadCommitted" }
		)
	);
}
