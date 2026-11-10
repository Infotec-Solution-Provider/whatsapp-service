import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Request } from "express";
import { readOdimAccessOnlyProfile, odimAccessOnlyProfilePath } from "./odim-access-only";

export const odimPilotSendPath = resolve(__dirname, "../../config/odim-pilot-send.json");
export interface OdimPilotSend {
	version: 1; enabled: true; instance: "odim"; recipient: string;
	clientId: number; contactId: number; chatId: number; userId: number;
	traceId: string; text: string; expiresAt: string;
}
export function readOdimPilotSend(filename = odimPilotSendPath): OdimPilotSend | null {
	let fd: number | undefined;
	try {
		const s = lstatSync(filename);
		if (!s.isFile() || s.isSymbolicLink() || s.size > 4096 || realpathSync(dirname(filename)) !== dirname(filename) ||
			(process.platform !== "win32" && ((s.mode & 0o077) !== 0 || s.uid !== process.getuid?.()))) return null;
		fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
		const stat = fstatSync(fd), p = JSON.parse(readFileSync(fd, "utf8"));
		if (stat.ino !== s.ino || stat.size !== s.size || stat.mtimeMs !== s.mtimeMs) return null;
		if (Object.keys(p).sort().join(",") !== "chatId,clientId,contactId,enabled,expiresAt,instance,recipient,text,traceId,userId,version" ||
			p.version !== 1 || p.enabled !== true || p.instance !== "odim" || !/^\d{10,15}$/.test(p.recipient) ||
			![p.clientId, p.contactId, p.chatId, p.userId].every(v => Number.isSafeInteger(v) && v > 0) ||
			!/^[a-f0-9-]{36}$/.test(p.traceId) || typeof p.text !== "string" || p.text.length < 10 || p.text.length > 500 ||
			!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= Date.now() || Date.parse(p.expiresAt) > Date.now() + 2 * 3600000) return null;
		return p;
	} catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
export function matchesOdimPilotSend(session: { instance: string; role?: string; userId: number }, clientId: number, body: any, pilot = readOdimPilotSend()): pilot is OdimPilotSend {
	return !!pilot && session.instance === "odim" && session.role === "ADMIN" && session.userId === pilot.userId &&
		clientId === pilot.clientId && !!body && Object.keys(body).sort().join(",") === "chatId,contactId,text,to,traceId" &&
		body.to === pilot.recipient && body.contactId === pilot.contactId && body.chatId === pilot.chatId && body.traceId === pilot.traceId && body.text === pilot.text;
}
export function odimPilotRequestAllowed(req: Request): boolean {
	const profile = readOdimAccessOnlyProfile(odimAccessOnlyProfilePath);
	return profile.enabled && profile.state === "valid" && req.method === "POST" && req.route?.path === "/api/whatsapp/:clientId/messages" &&
		!!req.is("application/json") && !req.headers["idempotency-key"] && matchesOdimPilotSend(req.session, Number(req.params["clientId"]), req.body);
}
