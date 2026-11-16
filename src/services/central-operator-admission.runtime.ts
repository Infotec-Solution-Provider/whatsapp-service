import prismaService from "./prisma.service";
import { centralAdmissionRequired, operatorPauseAdmission } from "./central-operator-admission";
import { canonicalRuntimeInstance } from "../operator-runtime/core";
import type { SessionData } from "../sdk-local";

export async function pauseEligibleOperatorIds(instance: string, ids: number[]): Promise<Set<number>> {
	instance = canonicalRuntimeInstance(instance);
	if (!await centralAdmissionRequired(prismaService, instance)) return new Set(ids);
	return prismaService.$transaction(tx => operatorPauseAdmission.eligible(tx, instance, ids));
}

export async function admitHumanSend(session: Pick<SessionData, "instance" | "userId">, chatId?: unknown, contactId?: unknown, to?: unknown): Promise<void> {
	if (session.userId <= 0) return;
	const instance = canonicalRuntimeInstance(session.instance);
	if (!await centralAdmissionRequired(prismaService, instance)) return;
	const id = (value: unknown) => {
		const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
		return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
	};
	return prismaService.$transaction(tx => operatorPauseAdmission.assertSend(tx, {
		instance, actorId: session.userId, chatId: id(chatId), contactId: id(contactId), to
	}));
}
