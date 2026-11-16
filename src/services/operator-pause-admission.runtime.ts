import prismaService from "./prisma.service";
import { tenantSqlEnabled } from "../tenant-sql/registry";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { operatorPauseAdmission } from "./operator-pause-admission";
import type { SessionData } from "../sdk-local";

export async function pauseEligibleOperatorIds(instance: string, ids: number[]): Promise<Set<number>> {
	if (!tenantSqlEnabled()) return new Set(ids);
	return withDatabaseTenant(instance, () => prismaService.$transaction(tx =>
		operatorPauseAdmission.eligible(tx, instance, ids, true)));
}

export async function admitHumanSend(session: Pick<SessionData, "instance" | "userId">, chatId?: unknown, contactId?: unknown, to?: unknown): Promise<void> {
	if (!tenantSqlEnabled() || session.userId <= 0) return;
	const id = (value: unknown) => {
		const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
		return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
	};
	return withDatabaseTenant(session.instance, () => prismaService.$transaction(tx => operatorPauseAdmission.assertSend(tx, {
		instance: session.instance, actorId: session.userId, chatId: id(chatId), contactId: id(contactId), to
	}, true)));
}
