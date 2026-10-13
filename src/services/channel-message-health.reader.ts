import type { DatabaseClient } from "./prisma.service";
import { Prisma } from "@prisma/client";
import { Logger } from "@in.pulse-crm/utils";
import {
	collectMessageHealth,
	MESSAGE_DELAY_MS,
	MESSAGE_HEALTH_WINDOW_MS,
	MessageHealthIssue,
	ChannelMessageHealth
} from "./channel-message-health";
import { sendFailureCategory, SendFailureCategory } from "../utils/send-failure-category";

type HealthDatabase = Pick<
	DatabaseClient,
	"wppMessage" | "remoteInboundEventInbox" | "wppMessageProcessingQueue" | "$queryRaw"
>;
interface InternalHealthRow {
	id: string;
	clientId: number | bigint;
	internalMessageId: number | null;
	status: string;
	lastRetryAt: string | null;
	error: string | null;
	createdAt: Date;
	processedAt: Date | null;
}
const ROW_LIMIT = 1_000;
const CACHE_MS = 15_000;

export class ChannelMessageHealthReader {
	private readonly cache = new Map<
		string,
		{ expiresAt: number; result: Promise<Map<number, ChannelMessageHealth>> }
	>();
	constructor(
		private readonly db: HealthDatabase,
		private readonly now = () => Date.now()
	) {}

	public read(instance: string, clientIds: number[]): Promise<Map<number, ChannelMessageHealth>> {
		const ids = [...new Set(clientIds)].sort((a, b) => a - b);
		const now = this.now();
		if (!ids.length) return Promise.resolve(new Map());
		const key = JSON.stringify([instance, ids]);
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > now) return cached.result;
		for (const [cacheKey, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(cacheKey);
		const result = this.load(instance, ids, now).catch((error: unknown) => {
			const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "UNCLASSIFIED";
			Logger.warning(
				`[ChannelHealth] Message health unavailable; instance=${instance.replace(/[\r\n\t]/g, " ").slice(0, 100)}; code=${code}`
			);
			return collectMessageHealth(ids, [], now, "UNAVAILABLE");
		});
		// Limit per-process scope cache as well as row reads; no background database polling.
		if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
		this.cache.set(key, { expiresAt: now + CACHE_MS, result });
		return result;
	}

	private async load(instance: string, ids: number[], now: number): Promise<Map<number, ChannelMessageHealth>> {
		const since = new Date(now - MESSAGE_HEALTH_WINDOW_MS);
		const delayed = new Date(now - MESSAGE_DELAY_MS);
		const [messages, inbox, processing, internal] = await Promise.all([
			this.db.wppMessage.findMany({
				where: {
					instance,
					clientId: { in: ids },
					OR: [
						{ from: { startsWith: "me:" } },
						{ from: { startsWith: "bot:" } },
						{ from: { startsWith: "user:" } }
					],
					AND: [
						{
							OR: [
								{
									status: { in: ["ERROR", "UNKNOWN"] },
									OR: [
										{ sentAt: { gte: since } },
										{ operatorOutbound: { completedAt: { gte: since } } }
									]
								},
								{ status: "PENDING", sentAt: { lt: delayed } }
							]
						}
					]
				},
				select: {
					id: true,
					clientId: true,
					status: true,
					sentAt: true,
					operatorOutbound: { select: { completedAt: true, error: true, providerOutcome: true } }
				},
				orderBy: [{ sentAt: "asc" }, { id: "asc" }],
				take: ROW_LIMIT + 1
			}),
			this.db.remoteInboundEventInbox.findMany({
				where: {
					clientId: { in: ids },
					eventType: "message-received",
					OR: [
						{ status: "FAILED", updatedAt: { gte: since } },
						{
							status: { in: ["PENDING", "PROCESSING"] },
							OR: [{ createdAt: { lt: delayed } }, { retryCount: { gt: 0 } }]
						}
					]
				},
				select: {
					id: true,
					clientId: true,
					messageId: true,
					status: true,
					retryCount: true,
					createdAt: true,
					updatedAt: true
				},
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
				take: ROW_LIMIT + 1
			}),
			this.db.wppMessageProcessingQueue.findMany({
				where: {
					instance,
					clientId: { in: ids },
					OR: [
						{ status: "FAILED", updatedAt: { gte: since } },
						{
							status: { in: ["PENDING", "PROCESSING"] },
							OR: [{ createdAt: { lt: delayed } }, { retryCount: { gt: 0 } }]
						}
					]
				},
				select: {
					id: true,
					clientId: true,
					messageId: true,
					status: true,
					retryCount: true,
					createdAt: true,
					updatedAt: true
				},
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
				take: ROW_LIMIT + 1
			}),
			// Project only metadata from LONGTEXT JSON; never bring message bodies/files into the monitor.
			this.db.$queryRaw<InternalHealthRow[]>(Prisma.sql`
				SELECT id, internal_message_id AS internalMessageId, status, error,
					created_at AS createdAt, processed_at AS processedAt,
					CAST(JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(message_data), message_data, '{}'), '$.clientId')) AS UNSIGNED) AS clientId,
					JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(message_data), message_data, '{}'), '$.lastRetryAt')) AS lastRetryAt
				FROM internal_message_processing_queue
				WHERE instance = ${instance}
					AND CAST(JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(message_data), message_data, '{}'), '$.clientId')) AS UNSIGNED) IN (${Prisma.join(ids)})
					AND ((status IN ('FAILED', 'UNKNOWN') AND processed_at >= ${since})
						OR (status IN ('PENDING', 'PROCESSING') AND created_at < ${delayed}))
				ORDER BY created_at ASC, id ASC
				LIMIT ${ROW_LIMIT + 1}
			`)
		]);
		const issues: MessageHealthIssue[] = [];
		for (const message of messages.slice(0, ROW_LIMIT)) {
			if (message.clientId === null) continue;
			const outcome = message.operatorOutbound?.providerOutcome as {
				failureCategory?: SendFailureCategory;
			} | null;
			const category = outcome?.failureCategory;
			issues.push({
				clientId: message.clientId,
				key: `message:${message.id}`,
				direction: "SEND",
				status: message.status === "PENDING" ? "PENDING" : message.status === "UNKNOWN" ? "UNKNOWN" : "FAILED",
				startedAt: message.sentAt,
				occurredAt: message.operatorOutbound?.completedAt || message.sentAt,
				category:
					category === "CHANNEL" || category === "MESSAGE"
						? category
						: sendFailureCategory(message.operatorOutbound?.error)
			});
		}
		for (const row of [...inbox.slice(0, ROW_LIMIT), ...processing.slice(0, ROW_LIMIT)]) {
			const key = row.messageId !== null ? `message:${row.messageId}` : `inbox:${row.id}`;
			if (row.status === "FAILED" || row.retryCount > 0)
				issues.push({
					clientId: row.clientId,
					key,
					direction: "RECEIVE",
					status: "FAILED",
					startedAt: row.createdAt,
					occurredAt: row.updatedAt
				});
			if (row.status === "PENDING" || row.status === "PROCESSING")
				issues.push({
					clientId: row.clientId,
					key,
					direction: "RECEIVE",
					status: "PENDING",
					startedAt: row.createdAt,
					occurredAt: row.updatedAt
				});
		}
		for (const row of internal.slice(0, ROW_LIMIT)) {
			const clientId = Number(row.clientId);
			if (!ids.includes(clientId)) continue;
			const retryAt = row.lastRetryAt ? Date.parse(row.lastRetryAt) : Number.NaN;
			issues.push({
				clientId,
				key: `internal:${row.internalMessageId ?? row.id}`,
				direction: "SEND",
				status: row.status === "UNKNOWN" ? "UNKNOWN" : row.status === "FAILED" ? "FAILED" : "PENDING",
				startedAt: Number.isFinite(retryAt)
					? new Date(Math.max(retryAt, row.createdAt.getTime()))
					: row.createdAt,
				occurredAt: row.processedAt || row.createdAt,
				category: sendFailureCategory(row.error)
			});
		}
		const limited = [messages, inbox, processing, internal].some((rows) => rows.length > ROW_LIMIT);
		return collectMessageHealth(ids, issues, now, limited ? "LIMITED" : "COMPLETE");
	}
}
