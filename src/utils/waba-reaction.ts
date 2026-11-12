import type { MessageReactionEvent } from "../types/remote-client.types";
import { MessageReactionError, reactionEmoji } from "./message-reaction";

export const WABA_REACTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export function isWabaMessageId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 191 && /^wamid\.[^\s]+$/u.test(value);
}
export function wabaPhone(value: unknown): string | null {
	if (typeof value !== "string" || !/^\+?[\d ()-]+$/.test(value)) return null;
	const digits = value.replace(/\D/g, "");
	return /^\d{10,15}$/.test(digits) ? digits : null;
}
export function wabaReactionActorIds(message: { from?: string; to?: string }): string[] {
	const peer = wabaPhone(message.from?.startsWith("me:") ? message.to : message.from);
	return peer ? ["self", `${peer}@s.whatsapp.net`] : ["self"];
}
export function wabaMessageTime(message: { timestamp?: unknown; sentAt?: unknown }): number {
	const raw = message.timestamp;
	const numeric = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
	const time = Number.isFinite(numeric) && numeric > 0 ? (numeric < 100_000_000_000 ? numeric * 1000 : numeric) :
		message.sentAt instanceof Date ? message.sentAt.getTime() : typeof message.sentAt === "string" ? Date.parse(message.sentAt) : NaN;
	return time;
}

/** Confirmed messages must belong to the same individual peer and official channel in either direction. */
export function assertWabaReactionTarget(message: {
	instance?: string; wabaId?: string | null; from?: string; to?: string; status?: string; type?: string; timestamp?: unknown; sentAt?: unknown;
}, recipient: string, ownPhone: string | null | undefined, now = Date.now()): string {
	const outbound = message.from?.startsWith("me:") === true;
	const ownSide = outbound ? message.from : message.to;
	const copiedOdim = message.instance === "odim" && ownSide === "me:odim-legacy-copy";
	const allowedTypes = ["text", "image", "video", "audio", "document", "sticker", "contacts", "vcard", "location", "interactive", "order", ...(copiedOdim ? ["chat"] : [])];
	const sentAt = wabaMessageTime(message);
	if (!isWabaMessageId(message.wabaId) || !allowedTypes.includes(message.type || "") ||
		!["SENT", "RECEIVED", "READ"].includes(message.status || "") ||
		!Number.isFinite(sentAt) || sentAt <= 0 || sentAt > now + 300_000 || now - sentAt > WABA_REACTION_MAX_AGE_MS) {
		throw new MessageReactionError("Esta mensagem não está disponível para reação no WhatsApp oficial.", 409);
	}
	const own = wabaPhone(ownPhone), peer = wabaPhone(outbound ? message.to : message.from);
	if (!own || !peer || peer !== recipient || peer === own || !ownSide?.startsWith("me:") || (!copiedOdim && wabaPhone(ownSide.slice(3)) !== own)) {
		throw new MessageReactionError("A reação deve apontar para uma mensagem deste canal individual.", 409);
	}
	return message.wabaId;
}

/** Pure parser shared by native ingress and the authenticated Odim mirror. No message insertion. */
export function parseWabaReaction(clientId: number, input: unknown, now = Date.now()): MessageReactionEvent {
	const message = input as { type?: unknown; id?: unknown; from?: unknown; timestamp?: unknown; reaction?: { message_id?: unknown; emoji?: unknown } } | null;
	if (!Number.isSafeInteger(clientId) || clientId <= 0 || message?.type !== "reaction" ||
		!isWabaMessageId(message.id) || !isWabaMessageId(message.reaction?.message_id) ||
		!wabaPhone(message.from) || typeof message.timestamp !== "string" || !/^\d{10}$/.test(message.timestamp) ||
		Number(message.timestamp) <= 0 || Number(message.timestamp) * 1000 > now + 300_000) {
		throw new MessageReactionError("Evento de reação WABA inválido.");
	}
	// Meta omits emoji in a removal event; empty emoji is also accepted.
	const emoji = reactionEmoji(message.reaction?.emoji === undefined ? "" : message.reaction.emoji);
	return { type: "message-reaction", clientId, targetMessageId: message.reaction!.message_id as string,
		reaction: emoji, removed: emoji === "", isGroup: false, groupId: null,
		actorId: `${wabaPhone(message.from)}@s.whatsapp.net`, fromMe: false,
		timestamp: Number(message.timestamp) * 1000, reactionId: message.id };
}

/** Preserve every item in a provider batch before the existing single-item handlers run. */
export function splitWabaWebhook(input: unknown): unknown[] {
	const body = input as { entry?: any[] } | null;
	if (!body || !Array.isArray(body.entry)) return [input];
	if (body.entry.length > 20) throw Error("WABA_WEBHOOK_BATCH_TOO_LARGE");
	const result: unknown[] = [];
	for (const entry of body.entry) {
		if (!Array.isArray(entry?.changes) || entry.changes.length > 20) throw Error("WABA_WEBHOOK_BATCH_INVALID");
		for (const change of entry.changes) {
			const value = change?.value;
			let hasItems = false;
			for (const kind of ["messages", "statuses"]) {
				if (value?.[kind] === undefined) continue;
				if (!Array.isArray(value[kind]) || value[kind].length > 100) throw Error("WABA_WEBHOOK_BATCH_INVALID");
				for (const item of value[kind]) {
					hasItems = true;
					const { messages: _messages, statuses: _statuses, ...metadata } = value;
					result.push({ ...body, entry: [{ ...entry, changes: [{ ...change, value: { ...metadata, [kind]: [item] } }] }] });
					if (result.length > 200) throw Error("WABA_WEBHOOK_BATCH_TOO_LARGE");
				}
			}
			if (!hasItems) result.push({ ...body, entry: [{ ...entry, changes: [change] }] });
		}
	}
	if (result.length > 200) throw Error("WABA_WEBHOOK_BATCH_TOO_LARGE");
	return result.length ? result : [input];
}
