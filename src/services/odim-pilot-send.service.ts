import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SessionData } from "../sdk-local";
import { SocketEventType } from "../sdk-local";
import { OdimAccessOnlyError, odimAccessOnlyProfilePath, readOdimAccessOnlyProfile } from "../utils/odim-access-only";
import { matchesOdimPilotSend, odimPilotSendPath, readOdimPilotSend } from "../utils/odim-pilot-send";
import { WabaDeliveryError } from "../utils/waba-send";
import WABAWhatsappClient from "../whatsapp-client/waba-whatsapp-client";
import prisma from "./prisma.service";
import socket from "./socket.service";
const conflict = (code: string) => Object.assign(new Error(code), { statusCode: 409 });

/** One fixed text/recipient/actor/expiry. Never registers a provider or a queue worker. */
export async function sendOdimPilotMessage(session: SessionData, clientId: number, body: any) {
	const p = readOdimPilotSend(), profile = readOdimAccessOnlyProfile(odimAccessOnlyProfilePath);
	if (!profile.enabled || profile.state !== "valid" || !matchesOdimPilotSend(session, clientId, body, p)) throw new OdimAccessOnlyError();
	const [contact, chat, client, recentIncoming] = await Promise.all([
		prisma.wppContact.findFirst({ where: { id: p.contactId, instance: "odim", isDeleted: false, isBlocked: false, whatsappId: p.recipient } }),
		prisma.wppChat.findFirst({ where: { id: p.chatId, instance: "odim", contactId: p.contactId, isFinished: false } }),
		prisma.wppClient.findFirst({ where: { id: p.clientId, instance: "odim", type: "WABA", isActive: false, sectors: { some: { instance: "odim", id: 138 } } } }),
		prisma.wppMessage.findFirst({ where: { instance: "odim", contactId: p.contactId, from: p.recipient, sentAt: { gte: new Date(Date.now() - 23 * 3600000) } }, select: { id: true } })
	]);
	if (!contact || !chat || !client?.WABAToken || !client.WABAAccountId || !client.WABAPhoneId) throw conflict("PILOT_IDENTITY_CHANGED");
	if (!recentIncoming) throw conflict("PILOT_REQUIRES_RECENT_INCOMING");
	const receipt = resolve(dirname(odimPilotSendPath), `odim-pilot-${p.traceId}.receipt.json`);
	let fd: number;
	try { fd = openSync(receipt, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600); }
	catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw conflict("PILOT_RESERVATION_FAILED");
		const prior = JSON.parse(readFileSync(receipt, "utf8"));
		if (prior.state === "SENT" && Number.isSafeInteger(prior.messageId)) {
			const saved = await prisma.wppMessage.findFirst({ where: { id: prior.messageId, instance: "odim", clientId: p.clientId, contactId: p.contactId, chatId: p.chatId } });
			if (saved) return saved;
		}
		throw conflict("PILOT_ALREADY_RESERVED_DO_NOT_RESEND");
	}
	const record = (state: string, messageId?: number) => ({ state, messageId, traceId: p.traceId, at: new Date().toISOString(), legacyRemainsOwner: true });
	try { writeFileSync(fd, JSON.stringify(record("RESERVED"))); fsyncSync(fd); } finally { closeSync(fd); }
	const syncDir = () => { const d = openSync(dirname(receipt), constants.O_RDONLY); try { fsyncSync(d); } finally { closeSync(d); } };
	if (process.platform !== "win32") syncDir();
	const finish = (state: string, messageId?: number) => { const temp = receipt + ".tmp"; const f = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { writeFileSync(f, JSON.stringify(record(state, messageId))); fsyncSync(f); } finally { closeSync(f); } renameSync(temp, receipt); if (process.platform !== "win32") syncDir(); };
	let messageId: number | undefined, dispatched = false;
	try {
		const now = new Date(), text = `*${session.name}*: ${p.text}`;
		const pending = await prisma.wppMessage.create({ data: { instance: "odim", from: `me:${client.phone}`, to: p.recipient, body: text, type: "chat", timestamp: String(now.getTime()), sentAt: now, status: "PENDING", clientId: p.clientId, contactId: p.contactId, chatId: p.chatId, userId: session.userId } }); messageId = pending.id;
		// Recheck expiry immediately before dispatch; the durable reservation is never removed.
		if (!matchesOdimPilotSend(session, clientId, body, readOdimPilotSend())) throw conflict("PILOT_EXPIRED_BEFORE_DISPATCH");
		const provider = new WABAWhatsappClient(client.id, "odim", client.name, client.phone || "", client.WABAPhoneId, client.WABAAccountId, client.WABAToken);
		dispatched = true;
		const sent = await provider.sendMessage({ to: p.recipient, text });
		if (typeof sent.wabaId !== "string" || !sent.wabaId.startsWith("wamid.")) throw new Error("PILOT_MISSING_PROVIDER_ID");
		const saved = await prisma.wppMessage.update({ where: { id: pending.id }, data: { wabaId: sent.wabaId, status: "SENT" } });
		finish("SENT", saved.id);
		try { await socket.emit(SocketEventType.WppMessage, `odim:chat:${p.chatId}`, { message: saved }); } catch { /* Authenticated polling reads the durable row. */ }
		return saved;
	} catch (error) {
		const unknown = dispatched && !(error instanceof WabaDeliveryError && error.deliveryStatus === "FAILED");
		if (messageId) await prisma.wppMessage.update({ where: { id: messageId }, data: { status: unknown ? "UNKNOWN" : "ERROR" } }).catch(() => {});
		try { finish(unknown ? "UNKNOWN" : "FAILED", messageId); } catch { /* RESERVED still prevents automatic retries. */ }
		throw conflict(unknown ? "PILOT_RESULT_UNKNOWN_DO_NOT_RESEND" : "PILOT_SEND_FAILED_INSPECT_RECEIPT");
	}
}
