import { Prisma } from "@prisma/client";

const MAX_TARGETS = 20;
const queueIdPattern = /^(?:[0-9a-f]{36}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const instancePattern = /^[a-z0-9][a-z0-9_-]{0,29}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
const mediaTypes = new Set(["audio", "document", "image", "sticker", "video"]);

export type Target = { id: string; instance: string; updatedAt: string };
type Candidate = { payload: unknown; status: string; updatedAt: string; connectionRefused: boolean; exhausted: boolean };
type ReadDatabase = Pick<Prisma.TransactionClient, "$queryRaw">;

export class RecoveryError extends Error {}

export function parsePlan(value: unknown): Target[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TARGETS) {
		throw new RecoveryError(`O plano deve conter de 1 a ${MAX_TARGETS} itens.`);
	}
	const ids = new Set<string>();
	const targets = value.map((item, index) => {
		const target = item as Partial<Target> | null;
		if (!target || typeof target.id !== "string" || !queueIdPattern.test(target.id) ||
			typeof target.instance !== "string" || !instancePattern.test(target.instance) ||
			typeof target.updatedAt !== "string" || !timestampPattern.test(target.updatedAt) || ids.has(target.id)) {
			throw new RecoveryError(`Item ${index + 1} tem ID de fila, instância ou versão inválida, ou ID repetido.`);
		}
		ids.add(target.id);
		return { id: target.id, instance: target.instance, updatedAt: target.updatedAt };
	});
	return targets;
}

type WebhookMessage = { id?: unknown; type?: unknown } & Record<string, unknown>;
type WebhookChange = { value?: { messages?: WebhookMessage[]; statuses?: unknown[]; metadata?: Record<string, unknown> } };
type WebhookPayload = { entry?: { changes?: WebhookChange[] }[] };

export function getMediaWebhook(payload: unknown) {
	const body = (typeof payload === "string" ? JSON.parse(payload) : payload) as WebhookPayload | null;
	const entries = body?.entry;
	const changes = entries?.[0]?.changes;
	const value = changes?.[0]?.value;
	const messages = value?.messages;
	const message = messages?.[0];
	if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(changes) || changes.length !== 1 ||
		!Array.isArray(messages) || messages.length !== 1 ||
		(value?.statuses !== undefined && (!Array.isArray(value.statuses) || value.statuses.length > 0)) ||
		typeof message?.id !== "string" || !message.id.startsWith("wamid.") ||
		typeof message.type !== "string" || !mediaTypes.has(message.type)) {
		return undefined;
	}
	const media = message[message.type] as { id?: unknown } | null | undefined;
	if (typeof media?.id === "string" && /^\d+$/.test(media.id)) {
		return { message, id: message.id, type: message.type, metadata: value?.metadata };
	}
	return undefined;
}

export function getMediaMessageId(payload: unknown): string | undefined {
	return getMediaWebhook(payload)?.id;
}

export async function readWabaCandidate(db: ReadDatabase, target: Target, lock: boolean) {
	const rowLock = lock ? Prisma.sql`FOR UPDATE` : Prisma.empty;
	const [row] = await db.$queryRaw<Candidate[]>(Prisma.sql`
		SELECT payload, status, LEFT(DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f'), 23) AS updatedAt,
			(retry_count >= max_retries AND max_retries >= 1) AS exhausted,
			(error LIKE '%Failed to fetch WABA media from storage-client%' AND error LIKE '%ECONNREFUSED%') AS connectionRefused
		FROM waba_webhook_queue WHERE id = ${target.id} AND instance = ${target.instance}
		${rowLock}
	`);
	return row;
}

export async function checkWabaRecoveryDatabase(db: ReadDatabase, database: string) {
	const [identity] = await db.$queryRaw<{ name: string }[]>(Prisma.sql`SELECT DATABASE() AS name`);
	if (identity?.name !== database) {
		throw new RecoveryError("O banco conectado difere do banco declarado no comando.");
	}
}
