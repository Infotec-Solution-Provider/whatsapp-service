import { BadRequestError, NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local";
import type { Prisma } from "@prisma/client";
import { homologTriageEnabled, TRIAGE_FLAG } from "../parameters/triage-feature";

export type TriageReader = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;
export type TriageWriter = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
export interface NamedResource {
	id: number;
	name: string;
}

export function requireInternal(session: SessionData) {
	if (!["ADMIN", "ATIVO", "AMBOS", "RECEP", "SUPERVISOR"].includes(session.role)) {
		throw new UnauthorizedError("Acesso restrito aos usuários internos autorizados.");
	}
}
export function requireAdmin(session: SessionData) {
	if (session.role !== "ADMIN") throw new UnauthorizedError("A delegação exige um administrador.");
}
export async function triageEnabled(db: TriageReader, instance: string) {
	if (homologTriageEnabled()) return true;
	const [setting] = await db.$queryRawUnsafe<{ value: string }[]>(
		"SELECT value FROM parameters WHERE instance=? AND scope='INSTANCE' AND `key`=? AND sectorId IS NULL AND userId IS NULL ORDER BY id DESC LIMIT 1",
		instance,
		TRIAGE_FLAG
	);
	return setting?.value === "true";
}
export async function requireFeature(db: TriageReader, session: SessionData) {
	requireInternal(session);
	if (!(await triageEnabled(db, session.instance)))
		throw new UnauthorizedError("A triagem está desabilitada nesta empresa.");
}
export async function findChannel(db: TriageReader, instance: string, channelId: number, lock = false) {
	const [channel] = await db.$queryRawUnsafe<NamedResource[]>(
		"SELECT id,name FROM clients WHERE instance=? AND id=? AND is_active=1" + (lock ? " FOR UPDATE" : ""),
		instance,
		channelId
	);
	return channel;
}
export async function authorizeChannel(db: TriageReader, session: SessionData, channelId: number, lock = false) {
	await requireFeature(db, session);
	const channel = await findChannel(db, session.instance, channelId, lock);
	if (!channel) throw new NotFoundError("Canal não encontrado.");
	if (session.role !== "ADMIN") {
		const [grant] = await db.$queryRawUnsafe<{ user_id: number }[]>(
			"SELECT user_id FROM triage_grants WHERE instance=? AND channel_id=? AND user_id=?" +
				(lock ? " FOR UPDATE" : ""),
			session.instance,
			channelId,
			session.userId
		);
		if (!grant) throw new UnauthorizedError("Você não tem acesso à triagem deste canal.");
	}
	return channel;
}
export async function channelSectors(db: TriageReader, instance: string, channelId: number) {
	return db.$queryRawUnsafe<NamedResource[]>(
		"SELECT s.id,s.name FROM sectors s JOIN _sector_clients sc ON sc.B=s.id WHERE sc.A=? AND s.instance=? AND s.receive_chats=1 ORDER BY s.name,s.id",
		channelId,
		instance
	);
}
export function requestBody(value: unknown, fields: readonly string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !fields.includes(key))
	) {
		throw new BadRequestError("Parâmetros inválidos para esta operação.");
	}
	return value as Record<string, unknown>;
}
