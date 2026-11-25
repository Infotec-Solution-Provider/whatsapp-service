import { Prisma, TriageSession, WppChat, WppContact, WppMessage } from "@prisma/client";
import db from "../services/prisma.service";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { getPublicMessageDirection } from "../utils/public-message-direction";
import { triageAuthoring } from "./authoring";
import { TRIAGE_CHAT_MARKER } from "./constants";
export { TRIAGE_CHAT_MARKER } from "./constants";
import {
	advanceTriage,
	summarizeTriageAnswers,
	type TriageDefinition,
	type TriageEvent,
	type TriageState,
	type TriageTurn
} from "./engine";

// Reserved runtime marker. Version and author-defined bot IDs live in the session.
export const triageJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export const definitionOf = (session: TriageSession) => session.definition as unknown as TriageDefinition;
export const stateOf = (session: TriageSession) => session.state as unknown as TriageState;
type Tx = Prisma.TransactionClient;
// A chat can acquire a triage session only in its creation transaction. Cache this
// immutable association so established human conversations need no per-turn join.
const knownChannels = new Map<string, number | null>();
async function channelOf(instance: string, chatId: number) {
	const key = instance + ":" + chatId;
	if (knownChannels.has(key)) return knownChannels.get(key);
	const session = await db.triageSession
		.findFirst({ where: { instance, chatId }, select: { channelId: true } })
		.catch((error) => {
			if (noTriageTables(error)) return null;
			throw error;
		});
	if (knownChannels.size >= 8192) knownChannels.delete(knownChannels.keys().next().value!);
	knownChannels.set(key, session?.channelId ?? null);
	return session?.channelId;
}

export function noTriageTables(error: unknown) {
	const code = (error as { code?: string } | null)?.code;
	return code === "P2021" || code === "ER_NO_SUCH_TABLE";
}

async function openChatForChannel(
	tx: Pick<Tx, "wppChat" | "triageSession">,
	instance: string,
	contactId: number,
	channelId: number,
	sectorIds: number[]
) {
	const candidates = await tx.wppChat.findMany({
		where: { instance, contactId, isFinished: false, sectorId: { in: sectorIds } },
		orderBy: { id: "desc" }
	});
	if (!candidates.length) return null;
	const owners = await tx.triageSession.findMany({
		where: { instance, chatId: { in: candidates.map((c) => c.id) } },
		select: { chatId: true, channelId: true }
	});
	const channels = new Map(owners.map((s) => [s.chatId, s.channelId]));
	return (
		candidates.find((c) => channels.get(c.id) === channelId) ?? candidates.find((c) => !channels.has(c.id)) ?? null
	);
}

export function acceptsTriageMessage(message: WppMessage) {
	return (
		getPublicMessageDirection(message).direction === "INBOUND" &&
		!!message.from &&
		!/@(g\.us|broadcast|newsletter)$/i.test(message.from) &&
		!/^(system|thirdparty|reaction|revoked|protocol|ciphertext|notification|call_log)(:|$)/i.test(message.type)
	);
}

/** Is an interrupted WABA insertion eligible for a triage-only replay, including after a pause? */
export async function hasTriageIngress(instance: string, channelId: number) {
	if (await triageAuthoring.activeForChannel(instance, channelId)) return true;
	return !!(await db.triageSession
		.findFirst({ where: { instance, channelId, status: { in: ["waiting", "handoff"] } }, select: { chatId: true } })
		.catch((error) => {
			if (noTriageTables(error)) return null;
			throw error;
		}));
}

export async function lockSession(tx: Tx, instance: string, chatId: number) {
	await tx.$queryRawUnsafe(
		"SELECT chat_id FROM triage_sessions WHERE instance=? AND chat_id=? FOR UPDATE",
		instance,
		chatId
	);
	return tx.triageSession.findFirst({ where: { instance, chatId } });
}

async function recordTurn(
	tx: Tx,
	session: TriageSession,
	key: string,
	event: TriageEvent,
	turn: TriageTurn,
	messageId: number
) {
	const { instance, chatId } = session;
	const entry = await tx.triageEvent.create({
		data: { instance, chatId, eventKey: key, kind: event.type, nodeId: turn.state.nodeId }
	});
	const effects: { kind: string; payload: Prisma.InputJsonValue }[] = turn.messages.map((text) => ({
		kind: "message",
		payload: { text }
	}));
	if (turn.handoff) effects.push({ kind: "handoff", payload: triageJson(turn.handoff) });
	for (const [position, effect] of effects.entries()) {
		await tx.triageEffect.create({
			data: { instance, chatId, eventId: entry.id, position, ...effect, status: "pending" }
		});
	}
	await tx.triageSession.update({
		where: { chatId },
		data: {
			state: triageJson(turn.state),
			status: turn.handoff ? "handoff" : "waiting",
			lastMessageId: messageId,
			deadline: turn.state.deadline && !turn.handoff ? new Date(turn.state.deadline) : null
		}
	});
}

export function triageSummary(session: TriageSession, reason: string) {
	const labels: Record<string, string> = {
		configured: "fluxo concluído",
		invalid: "limite de respostas inválidas",
		timeout: "tempo de espera encerrado",
		requested: "cliente pediu um atendente",
		manual: "atendimento assumido",
		delivery: "falha na entrega de mensagem",
		unavailable: "destino indisponível"
	};
	const answers = summarizeTriageAnswers(definitionOf(session), stateOf(session));
	return [
		"Resumo da triagem — " + (labels[reason] ?? reason),
		...answers.map((answer) => answer.label + ": " + answer.value)
	].join("\n");
}

export async function recordSummary(tx: Tx, session: TriageSession, reason: string) {
	const now = new Date();
	const chunks: string[] = [];
	let current = "";
	for (const line of triageSummary(session, reason).split("\n")) {
		if (current && Buffer.byteLength(current) + Buffer.byteLength(line) + 1 > 60_000) {
			chunks.push(current);
			current = "";
		}
		current += (current ? "\n" : "") + line;
	}
	if (current) chunks.push(current);
	const messages: WppMessage[] = [];
	for (const body of chunks)
		messages.push(
			await tx.wppMessage.create({
				data: {
					body,
					from: "system",
					to: "system",
					instance: session.instance,
					status: "RECEIVED",
					timestamp: String(now.getTime()),
					sentAt: now,
					type: "chat",
					chatId: session.chatId,
					contactId: session.contactId
				}
			})
		);
	return messages;
}

/** Called inside the same transaction as manual ownership/finish; effects already submitted cannot be recalled. */
export async function cancelTriageTx(tx: Tx, chat: Pick<WppChat, "id" | "instance" | "botId">) {
	if (chat.botId !== TRIAGE_CHAT_MARKER) return;
	const session = await lockSession(tx, chat.instance, chat.id);
	if (!session || !["waiting", "handoff"].includes(session.status)) return;
	await tx.triageSession.update({ where: { chatId: chat.id }, data: { status: "taken", deadline: null } });
	await tx.triageEffect.updateMany({
		where: { instance: chat.instance, chatId: chat.id, status: { in: ["pending", "working"] } },
		data: { status: "cancelled" }
	});
	await tx.triageEvent.create({
		data: { instance: chat.instance, chatId: chat.id, kind: "takeover", eventKey: "takeover:" + chat.id }
	});
	return recordSummary(tx, session, "manual");
}

export async function consumeTriage(
	instance: string,
	channelId: number,
	contact: WppContact,
	msg: WppMessage,
	current: WppChat | null
) {
	if (msg.instance !== instance || contact.instance !== instance || msg.clientId !== channelId) return null;
	if (!acceptsTriageMessage(msg)) {
		return current?.botId === TRIAGE_CHAT_MARKER ? { chat: current, handled: true, opened: false } : null;
	}
	const key = "message:" + msg.id;
	let excludedOtherChannel = false;
	if (current && (current.botId === TRIAGE_CHAT_MARKER || current.botId == null)) {
		const sourceChannel = await channelOf(instance, current.id);
		if (sourceChannel && sourceChannel !== channelId) {
			const channel = await db.wppClient.findFirstOrThrow({
				where: { instance, id: channelId },
				include: { sectors: true }
			});
			current = await openChatForChannel(
				db,
				instance,
				contact.id,
				channelId,
				channel.sectors.map((s) => s.id)
			);
			excludedOtherChannel = true;
		}
	}
	// The original inbound may replay after a handoff or finish. Never reopen its conversation.
	if (msg.chatId && current?.botId !== TRIAGE_CHAT_MARKER) {
		const replay = await db.triageEvent
			.findFirst({ where: { instance, chatId: msg.chatId, eventKey: key } })
			.catch((error) => {
				if (noTriageTables(error)) return null;
				throw error;
			});
		if (replay) {
			const chat = await db.wppChat.findFirstOrThrow({ where: { instance, id: replay.chatId } });
			return { chat, handled: true, opened: false };
		}
	}
	const ignored = excludedOtherChannel ? { chat: current, handled: false, opened: false } : null;
	if (current && current.botId !== TRIAGE_CHAT_MARKER) return ignored;
	if (!current && !(await triageAuthoring.activeForChannel(instance, channelId))) return ignored;
	return withDatabaseTenant(instance, () =>
		db.$transaction(
			async (tx) => {
				let chat = current;
				if (!chat) {
					const binding = await triageAuthoring.activeForChannel(instance, channelId, tx);
					if (!binding) return ignored;
					// Two webhook workers may both have observed no chat for this person.
					await tx.$queryRawUnsafe(
						"SELECT id FROM contacts WHERE instance=? AND id=? FOR UPDATE",
						instance,
						contact.id
					);
					const channel = await tx.wppClient.findFirstOrThrow({
						where: { instance, id: channelId },
						include: { sectors: true }
					});
					const sectorIds = channel.sectors.map((s) => s.id);
					const replay = await tx.triageEvent.findFirst({ where: { instance, eventKey: key } });
					if (replay)
						return {
							chat: await tx.wppChat.findFirstOrThrow({ where: { instance, id: replay.chatId } }),
							handled: true,
							opened: false
						};
					chat = await openChatForChannel(tx, instance, contact.id, channelId, sectorIds);
					if (!chat) {
						const sectorId = binding.definition.fallbackSectorId;
						if (!sectorId || !sectorIds.includes(sectorId)) return ignored;
						chat = await tx.wppChat.create({
							data: {
								instance,
								contactId: contact.id,
								type: "RECEPTIVE",
								botId: TRIAGE_CHAT_MARKER,
								sectorId,
								startedAt: new Date()
							}
						});
						const event = { type: "start", text: msg.body } as const;
						const turn = advanceTriage(binding.definition, null, event, new Date());
						const session = await tx.triageSession.create({
							data: {
								chatId: chat.id,
								instance,
								channelId,
								contactId: contact.id,
								botId: binding.botId,
								versionId: binding.versionId,
								definition: triageJson(binding.definition),
								state: triageJson(turn.state),
								status: "waiting",
								lastMessageId: msg.id
							}
						});
						await recordTurn(tx, session, key, event, turn, msg.id);
						await tx.wppMessage.update({
							where: { id: msg.id },
							data: { chatId: chat.id, contactId: contact.id }
						});
						return { chat, handled: true, opened: true };
					}
				}
				if (chat.botId !== TRIAGE_CHAT_MARKER) return { chat, handled: false, opened: false };
				const session = await lockSession(tx, instance, chat.id);
				if (!session) throw new Error("TRIAGE_SESSION_MISSING");
				if (session.channelId !== channelId || session.contactId !== contact.id)
					throw new Error("TRIAGE_CHAT_SCOPE_MISMATCH");
				if (await tx.triageEvent.findFirst({ where: { instance, eventKey: key } }))
					return { chat, handled: true, opened: false };
				if (session.status !== "waiting") {
					if (session.status === "handoff") {
						await tx.triageEvent.create({
							data: { instance, chatId: chat.id, eventKey: key, kind: "awaiting_handoff" }
						});
						await tx.wppMessage.update({
							where: { id: msg.id },
							data: { chatId: chat.id, contactId: contact.id }
						});
					}
					return { chat, handled: session.status === "handoff", opened: false };
				}
				const event = {
					type: "reply",
					text: msg.type === "chat" || msg.type === "text" ? msg.body : ""
				} as const;
				const turn = advanceTriage(definitionOf(session), stateOf(session), event, new Date());
				await recordTurn(tx, session, key, event, turn, msg.id);
				await tx.wppMessage.update({ where: { id: msg.id }, data: { chatId: chat.id, contactId: contact.id } });
				return { chat, handled: true, opened: false };
			},
			{ isolationLevel: "ReadCommitted" }
		)
	);
}

export async function expireTriage(instance: string, chatId: number, now: Date) {
	return withDatabaseTenant(instance, () =>
		db.$transaction(
			async (tx) => {
				const session = await lockSession(tx, instance, chatId);
				if (!session || session.status !== "waiting" || !session.deadline || session.deadline > now) return;
				const event = { type: "timeout" } as const;
				const turn = advanceTriage(definitionOf(session), stateOf(session), event, now);
				await recordTurn(
					tx,
					session,
					"timeout:" + chatId + ":" + session.deadline.getTime(),
					event,
					turn,
					session.lastMessageId
				);
			},
			{ isolationLevel: "ReadCommitted" }
		)
	);
}
