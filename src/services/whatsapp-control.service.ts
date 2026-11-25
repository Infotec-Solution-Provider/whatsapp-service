import { createHash } from "node:crypto";
import axios from "axios";
import type { SessionData } from "../sdk-local";
import { remoteControlBase } from "../utils/remote-control-host";
import database from "./prisma.service";

export class WhatsAppControlError extends Error {
	constructor(public readonly status: number, message: string) { super(message); }
}

const unavailable = { available: false, ready: false, canVideo: false, calls: [], media: [], cursor: 0 };
const tokenFor = (name: string) => {
	const value = process.env[name]?.trim();
	return value && Buffer.byteLength(value) >= 32 ? value : null;
};

async function requestHost(
	base: string, path: string, method: "get" | "post" | "put", headers: Record<string, string>,
	params: Record<string, string | number>, body?: unknown
) {
	try {
		const result = await axios.request<unknown>({
			url: base + path, method, params, headers, data: body, maxRedirects: 0,
			timeout: method === "get" ? 6500 : 35_000, maxContentLength: 2 * 1024 * 1024
		});
		return result.data;
	} catch (error) {
		const status = axios.isAxiosError(error) ? error.response?.status : undefined;
		if (status && status >= 400 && status < 500 && status !== 401) {
			const data = (error as { response?: { data?: { message?: unknown; error?: unknown } } }).response?.data;
			const detail = data?.message ?? data?.error;
			throw new WhatsAppControlError(status, typeof detail === "string" ? detail.slice(0, 250) : "O host recusou a operação.");
		}
		throw new WhatsAppControlError(503, "O host das sessões não confirmou a operação.");
	}
}

export async function manageChannel(session: SessionData, clientId: number, method: "get" | "put" | "post", suffix: string, body?: unknown) {
	const client = await database.wppClient.findFirst({
		where: { id: clientId, instance: session.instance, type: "REMOTE", isActive: true,
			...(session.sectorId ? { sectors: { some: { id: session.sectorId } } } : {}) },
		select: { remoteClientUrl: true, phone: true }
	});
	if (!client) throw new WhatsAppControlError(404, "Canal remoto não encontrado.");
	const base = remoteControlBase(client.remoteClientUrl);
	const token = tokenFor("WWEBJS_SESSION_MANAGEMENT_TOKEN");
	if (!base || !token) throw new WhatsAppControlError(503, "Gestão de sessões não habilitada para este host.");
	if ((suffix === "/primary" || suffix === "/group") && client.phone) {
		const expected = (body as { expectedPhone?: unknown })?.expectedPhone;
		if (typeof expected !== "string" || expected.replace(/\D/g, "") !== client.phone.replace(/\D/g, "")) {
			throw new WhatsAppControlError(409, "O número esperado difere do número cadastrado no canal.");
		}
	}
	return requestHost(base, `/api/session-management/channels/${clientId}${suffix}`, method,
		{ Authorization: `Bearer ${token}`, "x-whatsapp-actor-id": String(session.userId) }, { instance: session.instance }, body);
}

/** Accept a phone number from the CRM or a private WhatsApp JID. Never dial a group, LID as a phone, or a browser-supplied address. */
export function callPeer(phone: string | null, whatsappId: string | null): string | null {
	if (whatsappId?.includes("@") && !/^\d+@(lid|c\.us|s\.whatsapp\.net)$/.test(whatsappId)) return null;
	if (!phone?.trim() && /^\d{1,18}@lid$/.test(whatsappId ?? "")) return whatsappId;
	// Legacy numeric whatsappId may be a LID with the suffix stripped. Dial only a known phone or an explicitly typed JID.
	const raw = phone?.trim() || whatsappId?.match(/^(\d+)@(?:s\.whatsapp\.net|c\.us)$/)?.[1];
	if (!raw || !/^[+\d() .-]+$/.test(raw)) return null;
	const digits = raw.replace(/\D/g, "");
	return /^[1-9]\d{5,14}$/.test(digits) ? `${digits}@s.whatsapp.net` : null;
}

export type CallAction = "snapshot" | "start" | "accept" | "reject" | "end" | "media";

export async function operateChatCall(session: SessionData, chatId: number, tab: string, action: CallAction,
	callId: string, after: number, body?: { video: boolean } | { event: string }) {
	const token = tokenFor("WHATSAPP_CALLS_INTERNAL_KEY");
	const disabled = () => {
		if (action === "snapshot") return unavailable;
		throw new WhatsAppControlError(409, "Chamadas indisponíveis para este atendimento.");
	};
	if (!token) return disabled();
	// A chat can be transferred while ringing. Recheck assignment on every control and media poll.
	const chat = await database.wppChat.findFirst({
		where: { id: chatId, instance: session.instance, isFinished: false, userId: session.userId },
		select: { contact: { select: { instance: true, phone: true, whatsappId: true, isBlocked: true, isDeleted: true, isOnlyAdmin: true } },
			sector: { select: { defaultClientId: true } } }
	});
	if (!chat) throw new WhatsAppControlError(404, "Atendimento ativo não encontrado para este operador.");
	if (!chat.contact || chat.contact.instance !== session.instance || chat.contact.isBlocked || chat.contact.isDeleted ||
		(chat.contact.isOnlyAdmin && session.role !== "ADMIN")) return disabled();
	const peerJid = callPeer(chat.contact.phone, chat.contact.whatsappId);
	if (!peerJid) return disabled();
	const last = await database.wppMessage.findFirst({
		where: { chatId, instance: session.instance, clientId: { not: null } },
		select: { clientId: true }, orderBy: { id: "desc" }
	});
	const clientId = last?.clientId ?? chat.sector?.defaultClientId;
	if (!clientId) return disabled();
	const client = await database.wppClient.findFirst({
		where: { id: clientId, instance: session.instance, isActive: true, type: "REMOTE" }, select: { remoteClientUrl: true }
	});
	const base = remoteControlBase(client?.remoteClientUrl ?? null);
	if (!base) return disabled();
	const owner = createHash("sha256").update(JSON.stringify([session.instance, session.userId, chatId, tab])).digest("hex");
	const headers = {
		"x-whatsapp-calls-key": token, "x-whatsapp-calls-owner": owner,
		"x-whatsapp-calls-instance": session.instance, "x-whatsapp-calls-client-id": String(clientId)
	};
	const path = "/api/internal/whatsapp-calls/%40primary";
	if (action === "snapshot") return requestHost(base, path, "get", headers, { peerJid, after });
	if (action === "start") return requestHost(base, path + "/start", "post", headers, { peerJid }, { ...body, peerJid });
	return requestHost(base, `${path}/${encodeURIComponent(callId)}/${action}`, "post", headers, { peerJid }, body);
}
