import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { Prisma, RemoteInboundEventInbox, RemoteInboundEventInboxStatus } from "@prisma/client";
import { Logger } from "@in.pulse-crm/utils";
import MessageDto from "../types/remote-client.types";
import prismaService from "./prisma.service";

const DEFAULT_PROCESSING_INTERVAL_MS = 250;
const DEFAULT_LOCK_DURATION_MS = 60_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 191;

export class RemoteInboundInboxRequestError extends Error {
	constructor(message: string, public readonly statusCode: 400 | 409) {
		super(message);
		this.name = "RemoteInboundInboxRequestError";
	}
}

export interface RemoteInboundMessagePayload {
	type: "message-received";
	clientId: number;
	message: MessageDto;
}

export interface RemoteInboundInboxProcessResult {
	messageId: number | null;
}

export interface RemoteInboundInboxProcessor {
	process(item: RemoteInboundEventInbox, payload: RemoteInboundMessagePayload): Promise<RemoteInboundInboxProcessResult>;
}

export interface RemoteInboundInboxEnqueueResult {
	created: boolean;
	id: string;
	idempotencyKey: string;
	status: RemoteInboundEventInboxStatus;
}

function canonicalize(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map((item) => canonicalize(item));
	if (typeof value === "object") {
		const source = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			if (source[key] !== undefined) result[key] = canonicalize(source[key]);
		}
		return result;
	}
	return value === undefined ? null : String(value);
}

export function hashRemoteInboundPayload(payload: RemoteInboundMessagePayload): string {
	return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

export function getRemoteInboundProviderMessageId(message: MessageDto): string {
	const messageId = message.wwebjsIdStanza?.trim() || message.wwebjsId?.trim();
	if (!messageId) {
		throw new RemoteInboundInboxRequestError("message-received requires wwebjsIdStanza or wwebjsId", 400);
	}
	return messageId;
}

export function resolveRemoteInboundIdempotencyKey(
	explicitKey: string | undefined,
	clientId: number,
	message: MessageDto
): string {
	const providerMessageId = getRemoteInboundProviderMessageId(message);
	const key = explicitKey?.trim() || `remote-message:v1:${clientId}:${providerMessageId}`;
	if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
		throw new RemoteInboundInboxRequestError(
			`Idempotency-Key must have at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
			400
		);
	}
	return key;
}

export function calculateRemoteInboundRetryDelayMs(retryCount: number): number {
	return Math.min(300_000, 1_000 * 2 ** Math.min(Math.max(retryCount, 0), 8));
}

export function assertRemoteInboundPayloadMatches(
	idempotencyKey: string,
	existingPayloadHash: string,
	incomingPayloadHash: string
): void {
	if (existingPayloadHash !== incomingPayloadHash) {
		throw new RemoteInboundInboxRequestError(
			`Idempotency-Key "${idempotencyKey}" was already used with a different payload`,
			409
		);
	}
}

class RemoteInboundEventInboxService {
	private readonly processingIntervalMs = Math.max(
		50,
		Number(process.env["REMOTE_INBOUND_EVENT_INTERVAL_MS"] || DEFAULT_PROCESSING_INTERVAL_MS)
	);
	private readonly lockDurationMs = Math.max(
		5_000,
		Number(process.env["REMOTE_INBOUND_EVENT_LOCK_MS"] || DEFAULT_LOCK_DURATION_MS)
	);
	private readonly workerId = `${hostname()}-${process.pid}-${Date.now()}`;
	private timer: NodeJS.Timeout | null = null;
	private processing = false;
	private stopping = false;
	private processor: RemoteInboundInboxProcessor | null = null;

	public setProcessor(processor: RemoteInboundInboxProcessor): void {
		this.processor = processor;
	}

	public async enqueue(
		clientId: number,
		message: MessageDto,
		explicitIdempotencyKey?: string
	): Promise<RemoteInboundInboxEnqueueResult> {
		const providerMessageId = getRemoteInboundProviderMessageId(message);
		const idempotencyKey = resolveRemoteInboundIdempotencyKey(explicitIdempotencyKey, clientId, message);
		const payload: RemoteInboundMessagePayload = { type: "message-received", clientId, message };
		const payloadHash = hashRemoteInboundPayload(payload);
		const jsonPayload = canonicalize(payload) as Prisma.InputJsonValue;
		const findExisting = () => prismaService.remoteInboundEventInbox.findFirst({
			where: {
				OR: [
					{ idempotencyKey },
					{ clientId, eventType: payload.type, providerMessageId }
				]
			}
		});

		let created = false;
		let item: RemoteInboundEventInbox;
		try {
			// The canonical event tuple also protects a rolling deployment where an
			// old producer has no Idempotency-Key while the new outbox sends one.
			const existing = await findExisting();
			if (existing) {
				item = existing;
			} else {
				item = await prismaService.remoteInboundEventInbox.create({
					data: {
						idempotencyKey,
						clientId,
						eventType: payload.type,
						providerMessageId,
						payloadHash,
						payload: jsonPayload,
						// A durable HTTP ACK must never turn a later outage into a
						// terminally discarded inbound event.
						maxRetries: 0
					}
				});
				created = true;
			}
		} catch (error) {
			if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
			const racedItem = await findExisting();
			if (!racedItem) throw error;
			item = racedItem;
		}

		// Reuse of the same transport key with a different payload is a client
		// error. A match found only by the canonical event tuple is the expected
		// FIRST-ARRIVAL-WINS case: keep the already durable payload unchanged.
		if (item.idempotencyKey === idempotencyKey) {
			assertRemoteInboundPayloadMatches(idempotencyKey, item.payloadHash, payloadHash);
		}

		if (!created && item.status === "FAILED") {
			item = await prismaService.remoteInboundEventInbox.update({
				where: { id: item.id },
				data: {
					status: "PENDING",
					retryCount: 0,
					error: null,
					nextAttemptAt: new Date(),
					lockedUntil: null,
					lockedBy: null,
					processingStartedAt: null
				}
			});
		}

		void this.processOnce().catch((error) => {
			Logger.error("[RemoteInboundInbox] Immediate processing failed", error as Error);
		});

		return { created, id: item.id, idempotencyKey: item.idempotencyKey, status: item.status };
	}

	public startWorker(): void {
		if (this.timer) return;
		this.stopping = false;
		this.timer = setInterval(() => {
			void this.processOnce().catch((error) => {
				Logger.error("[RemoteInboundInbox] Processing loop failed", error as Error);
			});
		}, this.processingIntervalMs);
		this.timer.unref();
		void this.processOnce().catch((error) => {
			Logger.error("[RemoteInboundInbox] Initial processing failed", error as Error);
		});
	}

	public stopWorker(): void {
		this.stopping = true;
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	public async stopAndDrain(timeoutMs = 30_000): Promise<void> {
		this.stopWorker();
		const deadline = Date.now() + timeoutMs;
		while (this.processing && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	public async processOnce(): Promise<void> {
		if (this.stopping || this.processing || !this.processor) return;
		this.processing = true;
		try {
			await this.releaseExpiredLocks();
			const now = new Date();
			const candidates = await prismaService.remoteInboundEventInbox.findMany({
				where: { status: "PENDING", nextAttemptAt: { lte: now } },
				orderBy: { createdAt: "asc" },
				take: 20
			});
			await Promise.all(candidates.map((item) => this.claimAndProcess(item.id)));
		} finally {
			this.processing = false;
		}
	}

	private async claimAndProcess(id: string): Promise<void> {
		const claimed = await prismaService.remoteInboundEventInbox.updateMany({
			where: { id, status: "PENDING", nextAttemptAt: { lte: new Date() } },
			data: {
				status: "PROCESSING",
				lockedBy: this.workerId,
				lockedUntil: new Date(Date.now() + this.lockDurationMs),
				processingStartedAt: new Date()
			}
		});
		if (claimed.count !== 1 || !this.processor) return;

		const item = await prismaService.remoteInboundEventInbox.findUnique({ where: { id } });
		if (!item || item.lockedBy !== this.workerId || item.status !== "PROCESSING") return;

		const leaseHeartbeat = setInterval(() => {
			void prismaService.remoteInboundEventInbox.updateMany({
				where: { id, status: "PROCESSING", lockedBy: this.workerId },
				data: { lockedUntil: new Date(Date.now() + this.lockDurationMs) }
			}).catch((error) => {
				Logger.error(`[RemoteInboundInbox] Failed to renew lease for ${id}`, error as Error);
			});
		}, Math.max(1_000, Math.floor(this.lockDurationMs / 3)));
		leaseHeartbeat.unref();

		try {
			const payload = item.payload as unknown as RemoteInboundMessagePayload;
			const result = await this.processor.process(item, payload);
			const completed = await prismaService.remoteInboundEventInbox.updateMany({
				where: { id, status: "PROCESSING", lockedBy: this.workerId },
				data: {
					status: "COMPLETED",
					messageId: result.messageId,
					completedAt: new Date(),
					error: null,
					lockedBy: null,
					lockedUntil: null
				}
			});
			if (completed.count !== 1) throw new Error(`Inbound inbox item ${id} lost its processing lease`);
		} catch (error) {
			await this.recordFailure(item, error);
		} finally {
			clearInterval(leaseHeartbeat);
		}
	}

	private async recordFailure(item: RemoteInboundEventInbox, error: unknown): Promise<void> {
		const retryCount = item.retryCount + 1;
		const terminal = item.maxRetries > 0 && retryCount >= item.maxRetries;
		const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
		await prismaService.remoteInboundEventInbox.updateMany({
			where: { id: item.id, status: "PROCESSING", lockedBy: this.workerId },
			data: {
				status: terminal ? "FAILED" : "PENDING",
				retryCount,
				error: message,
				nextAttemptAt: new Date(Date.now() + calculateRemoteInboundRetryDelayMs(retryCount)),
				lockedBy: null,
				lockedUntil: null
			}
		});
		Logger.error(`[RemoteInboundInbox] Failed to process ${item.id}: ${message}`, error as Error);
	}

	private async releaseExpiredLocks(): Promise<void> {
		await prismaService.remoteInboundEventInbox.updateMany({
			where: { status: "PROCESSING", lockedUntil: { lt: new Date() } },
			data: {
				status: "PENDING",
				lockedBy: null,
				lockedUntil: null,
				processingStartedAt: null,
				nextAttemptAt: new Date()
			}
		});
	}
}

export default new RemoteInboundEventInboxService();
