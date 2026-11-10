import type { SessionData } from "../sdk-local";
import { sameTenantIdentity } from "./odim-access-only";

type SessionScope = Pick<SessionData, "instance" | "userId" | "role" | "sectorId">;
type ChatScope = { instance: string; userId: number | null; sectorId: number | null };

/** CRM identities are preserved for the Odim tenant; sharing never changes ownership. */
export function odimSupervisionPeer(session: SessionScope): number | null {
	if (!sameTenantIdentity(session.instance, "odim") || session.role !== "ADMIN" ||
		!Number.isSafeInteger(session.sectorId) || session.sectorId <= 0) return null;
	return session.userId === 6 ? 9 : session.userId === 9 ? 6 : null;
}

export function odimSupervisionSharedChatScope(session: SessionScope) {
	const peer = odimSupervisionPeer(session);
	return peer === null ? [] : [{ userId: peer, sectorId: session.sectorId }];
}

export function keepsOdimSupervisionAccess(previous: ChatScope, next: ChatScope): boolean {
	return sameTenantIdentity(previous.instance, "odim") && sameTenantIdentity(next.instance, "odim") &&
		Number.isSafeInteger(previous.sectorId) && (previous.sectorId ?? 0) > 0 && previous.sectorId === next.sectorId &&
		(previous.userId === 6 || previous.userId === 9) && (next.userId === 6 || next.userId === 9);
}
