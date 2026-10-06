import { Logger } from "@in.pulse-crm/utils";
import { Prisma } from "@prisma/client";
import prismaService from "./prisma.service";
import type { InternalWppOutcome } from "../utils/internal-wpp-send-outcome";

export interface InternalWhatsappQueueTiming {
	firstClaimAt?: string;
	submittedAt?: string;
	slowAlertedAt?: string;
	completedAt?: string;
}

export interface InternalWhatsappQueuePayload {
	clientId: number;
	remoteJobId?: string;
	timing?: InternalWhatsappQueueTiming;
	outcome?: InternalWppOutcome;
	/** Manual "Reenviar" count; each generation uses its own remote idempotency key. */
	retryGeneration?: number;
	lastRetryAt?: string;
	lastRetryBy?: number;
	session: {
		userId: number;
		sectorId: number;
		role: string;
		instance: string;
		name: string;
	};
	data: {
		sendAsAudio?: boolean;
		sendAsDocument?: boolean;
		quotedId?: string | null;
		mentions?: unknown;
	};
}

interface EnqueueInput {
	instance: string;
	internalChatId: number;
	internalMessageId: number;
	groupId: string;
	authorName: string;
	payload: InternalWhatsappQueuePayload;
}

export interface InternalWhatsappQueueProcessResult {
	status: "PENDING" | "COMPLETED" | "FAILED" | "UNKNOWN";
	error?: string;
	/** Updated payload JSON, persisted in the same write as the status (no extra query). */
	messageData?: string;
}

export type InternalWhatsappQueueItem = Awaited<
	ReturnType<typeof prismaService.internalMessageProcessingQueue.findFirstOrThrow>
>;
export interface InternalWhatsappQueueProcessHandler {
	process(item: InternalWhatsappQueueItem): Promise<InternalWhatsappQueueProcessResult>;
}

class InternalWhatsappMessageQueueService {
	private readonly workerId = `internal-wpp-worker-${process.pid}-${Date.now()}`;
	private readonly intervalMs = Math.max(250, Number(process.env["INTERNAL_WPP_QUEUE_INTERVAL_MS"] || 500));
	private readonly pollDelayMs = Math.max(500, Number(process.env["INTERNAL_WPP_JOB_POLL_INTERVAL_MS"] || 1500));
	private readonly lockDurationMs = Math.max(
		10000,
		Number(process.env["INTERNAL_WPP_QUEUE_LOCK_DURATION_MS"] || 30000)
	);
	private readonly retentionDays = Math.max(1, Number(process.env["INTERNAL_WPP_QUEUE_RETENTION_DAYS"]) || 30);
	private interval: NodeJS.Timeout | null = null;
	private processing = false;
	private handler: InternalWhatsappQueueProcessHandler | null = null;

	public setProcessHandler(handler: InternalWhatsappQueueProcessHandler): void {
		this.handler = handler;
	}

	public async enqueue(input: EnqueueInput): Promise<string> {
		const existing = await prismaService.internalMessageProcessingQueue.findFirst({
			where: { internalMessageId: input.internalMessageId },
			select: { id: true }
		});
		if (existing) return existing.id;

		try {
			const item = await prismaService.internalMessageProcessingQueue.create({
				data: {
					instance: input.instance,
					internalChatId: input.internalChatId,
					internalMessageId: input.internalMessageId,
					groupId: input.groupId,
					authorName: input.authorName,
					messageData: JSON.stringify(input.payload),
					status: "PENDING"
				}
			});
			return item.id;
		} catch (error) {
			if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
				const raced = await prismaService.internalMessageProcessingQueue.findFirstOrThrow({
					where: { internalMessageId: input.internalMessageId },
					select: { id: true }
				});
				return raced.id;
			}
			throw error;
		}
	}

	/**
	 * Re-opens a terminal item for a manual resend (new retry generation).
	 * Conditional on the terminal status so it can never touch an item in flight, and
	 * on the payload the caller read so a stale snapshot (e.g. a request that stalled
	 * past a whole earlier resend) cannot reopen with outdated retry decisions.
	 */
	public async reopenForManualRetry(id: string, expectedMessageData: string, messageData: string): Promise<boolean> {
		const reopened = await prismaService.internalMessageProcessingQueue.updateMany({
			where: { id, status: { in: ["FAILED", "UNKNOWN"] }, messageData: expectedMessageData },
			data: {
				status: "PENDING",
				error: null,
				lockedBy: null,
				lockedUntil: null,
				processedAt: null,
				processingStartedAt: null,
				retryCount: 0,
				messageData
			}
		});
		return reopened.count === 1;
	}

	public startWorker(): void {
		if (this.interval) return;
		if (!this.handler) throw new Error("Internal WhatsApp queue process handler is not configured");

		void this.recoverInterruptedItems().catch((error) => {
			Logger.error(
				`[InternalWhatsappQueue] Recovery failed: ${error instanceof Error ? error.message : String(error)}`
			);
		});
		this.interval = setInterval(() => void this.processNext(), this.intervalMs);
		void this.processNext();
		Logger.info(`[InternalWhatsappQueue] Worker started with ${this.intervalMs}ms interval`);
	}

	public stopWorker(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
	}

	// `processingStartedAt` is the FIRST claim time of the current delivery (set only
	// while null). Re-polls, thrown-error retries and restart recovery keep it, so
	// `processedAt - processingStartedAt` measures the whole delivery. Until 2026-10
	// it held the last poll's claim time (~0.25 s on every row). A manual
	// "Reenviar" (new retry generation) clears it to start a new measurement.
	private async recoverInterruptedItems(): Promise<void> {
		const result = await prismaService.internalMessageProcessingQueue.updateMany({
			where: { status: "PROCESSING" },
			data: {
				status: "PENDING",
				lockedBy: null,
				lockedUntil: null
			}
		});
		if (result.count > 0) {
			Logger.info(`[InternalWhatsappQueue] Recovered ${result.count} interrupted item(s)`);
		}

		const removed = await prismaService.internalMessageProcessingQueue.deleteMany({
			where: {
				status: { in: ["COMPLETED", "FAILED", "UNKNOWN"] },
				processedAt: { lt: new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000) }
			}
		});
		if (removed.count > 0) {
			Logger.info(
				`[InternalWhatsappQueue] Removed ${removed.count} terminal item(s) older than ${this.retentionDays} days`
			);
		}
	}

	private async processNext(): Promise<void> {
		if (this.processing || !this.handler) return;
		this.processing = true;

		try {
			const now = new Date();
			const item = await prismaService.internalMessageProcessingQueue.findFirst({
				where: {
					status: "PENDING",
					OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }]
				},
				orderBy: { createdAt: "asc" }
			});
			if (!item) return;

			const processingStartedAt = item.processingStartedAt ?? new Date();
			const claimed = await prismaService.internalMessageProcessingQueue.updateMany({
				where: { id: item.id, status: "PENDING" },
				data: {
					status: "PROCESSING",
					lockedBy: this.workerId,
					lockedUntil: new Date(Date.now() + this.lockDurationMs),
					processingStartedAt
				}
			});
			if (claimed.count !== 1) return;

			await this.processClaimed({ ...item, processingStartedAt });
		} catch (error) {
			Logger.error(
				`[InternalWhatsappQueue] Processing loop failed: ${error instanceof Error ? error.message : String(error)}`
			);
		} finally {
			this.processing = false;
		}
	}

	private async processClaimed(item: InternalWhatsappQueueItem): Promise<void> {
		try {
			const result = await this.handler!.process(item);
			if (result.status === "PENDING") {
				await prismaService.internalMessageProcessingQueue.update({
					where: { id: item.id },
					data: {
						status: "PENDING",
						lockedBy: null,
						lockedUntil: new Date(Date.now() + this.pollDelayMs),
						...(result.messageData !== undefined ? { messageData: result.messageData } : {})
					}
				});
				return;
			}

			await prismaService.internalMessageProcessingQueue.update({
				where: { id: item.id },
				data: {
					status: result.status,
					error: result.error?.slice(0, 4000) || null,
					processedAt: new Date(),
					lockedBy: null,
					lockedUntil: null,
					...(result.messageData !== undefined ? { messageData: result.messageData } : {})
				}
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const retryCount = item.retryCount + 1;
			const retryDelay = Math.min(60000, this.pollDelayMs * 2 ** Math.min(retryCount, 6));
			await prismaService.internalMessageProcessingQueue.update({
				where: { id: item.id },
				data: {
					status: "PENDING",
					retryCount: { increment: 1 },
					error: errorMessage.slice(0, 4000),
					lockedBy: null,
					lockedUntil: new Date(Date.now() + retryDelay)
				}
			});
			Logger.error(`[InternalWhatsappQueue] Item ${item.id} will retry idempotently: ${errorMessage}`);
		}
	}
}

export default new InternalWhatsappMessageQueueService();
