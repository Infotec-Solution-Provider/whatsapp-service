import { createHash } from "node:crypto";
import type { SessionData } from "../../sdk-local";

export const CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export interface ChangeCursor { version: 1; scope: string; epoch: string; sequence: string; issuedAt: number }

export function cursorScope(session: SessionData, wallets: number[]): string {
	return createHash("sha256").update(JSON.stringify([
		session.instance, session.userId, session.sectorId, session.role, [...wallets].sort((a, b) => a - b)
	])).digest("hex");
}

export function encodeCursor(scope: string, epoch: string, sequence: string, now = Date.now()): string {
	return Buffer.from(JSON.stringify({ version: 1, scope, epoch, sequence, issuedAt: now })).toString("base64url");
}

export function decodeCursor(value: unknown, scope: string, now = Date.now()): ChangeCursor | null {
	if (typeof value !== "string" || value.length > 1024 || !/^[\w-]+$/.test(value)) return null;
	try {
		const data = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as ChangeCursor;
		if (data.version !== 1 || data.scope !== scope || typeof data.epoch !== "string" ||
			typeof data.sequence !== "string" || !/^\d{1,20}$/.test(data.sequence) ||
			!Number.isSafeInteger(data.issuedAt) || data.issuedAt > now + 60000 || now - data.issuedAt > CURSOR_TTL_MS) return null;
		return data;
	} catch { return null; }
}
