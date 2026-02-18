import "dotenv/config";
import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { randomUUID } from "crypto";
import prismaService from "./prisma.service";
import wabaService from "./waba.service";

const QUEUE_POLL_INTERVAL = parseInt(process.env["WABA_WEBHOOK_QUEUE_POLL_INTERVAL"] || "1000", 10);
const MAX_CONCURRENT_PROCESSING = parseInt(process.env["WABA_WEBHOOK_MAX_CONCURRENT"] || "5", 10);

const WABA_QUEUE_STATUS = {
	PENDING: "PENDING",
	PROCESSING: "PROCESSING",
	COMPLETED: "COMPLETED",
	FAILED: "FAILED",
	IGNORED: "IGNORED"
} as const;

type WABAQueueStatus = (typeof WABA_QUEUE_STATUS)[keyof typeof WABA_QUEUE_STATUS];

interface WABAWebhookQueueRow {
	id: string;
	instance: string;
	payload: unknown;
	retryCount: number;
	maxRetries: number;
}

class WABAWebhookQueueService {
	private isProcessing = false;
	private activeProcessing = 0;

	public async enqueue(instance: string, payload: unknown): Promise<string> {
		const id = randomUUID();
		const payloadJson = this.stringifyPayload(payload);

		await prismaService.$executeRawUnsafe(
			`INSERT INTO waba_webhook_queue (
				id, instance, payload, status, retry_count, max_retries, created_at, updated_at
			) VALUES (?, ?, CAST(? AS JSON), ?, 0, 3, NOW(3), NOW(3))`,
			id,
			instance,
			payloadJson,
			WABA_QUEUE_STATUS.PENDING
		);

		return id;
	}

	public startProcessor(): void {
		if (this.isProcessing) {
			return;
		}

		this.isProcessing = true;
		Logger.info("Starting WABA webhook queue processor");
		this.processLoop();
	}

	public stopProcessor(): void {
		this.isProcessing = false;
		Logger.info("Stopping WABA webhook queue processor");
	}

	private async processLoop(): Promise<void> {
		while (this.isProcessing) {
			try {
				if (this.activeProcessing < MAX_CONCURRENT_PROCESSING) {
					const item = await this.getNextPendingItem();
					if (item) {
						this.activeProcessing++;
						this.processItem(item.id).finally(() => {
							this.activeProcessing--;
						});
					}
				}
			} catch (err) {
				Logger.error("Error in WABA webhook queue loop", err as Error);
			}

			await this.sleep(QUEUE_POLL_INTERVAL);
		}
	}

	private async getNextPendingItem() {
		const rows = await prismaService.$queryRawUnsafe<WABAWebhookQueueRow[]>(
			`SELECT
				id,
				instance,
				payload,
				retry_count AS retryCount,
				max_retries AS maxRetries
			 FROM waba_webhook_queue
			 WHERE status = ?
			 ORDER BY created_at ASC
			 LIMIT 1`,
			WABA_QUEUE_STATUS.PENDING
		);

		return rows[0] || null;
	}

	private async processItem(id: string): Promise<void> {
		const item = await this.markAsProcessingAndGet(id);
		if (!item) {
			return;
		}

		try {
			const result = await wabaService.handleWebhookEntry(item.instance, this.parsePayload(item.payload));

			if (result.ignored) {
				await prismaService.$executeRawUnsafe(
					`UPDATE waba_webhook_queue
					 SET status = ?, ignored_reason = ?, error = NULL, processed_at = NOW(3), updated_at = NOW(3)
					 WHERE id = ?`,
					WABA_QUEUE_STATUS.IGNORED,
					result.reason || "Webhook ignorado",
					id
				);
				return;
			}

			await prismaService.$executeRawUnsafe(
				`UPDATE waba_webhook_queue
				 SET status = ?, processed_at = NOW(3), updated_at = NOW(3), error = NULL, ignored_reason = NULL
				 WHERE id = ?`,
				WABA_QUEUE_STATUS.COMPLETED,
				id
			);
		} catch (err: any) {
			const newRetryCount = item.retryCount + 1;
			const shouldRetry = newRetryCount < item.maxRetries;
			const safeError = sanitizeErrorMessage(err);
			const errorMessage = typeof safeError === "string" && safeError.trim().length > 0
				? safeError
				: "Unknown error";

			await prismaService.$executeRawUnsafe(
				`UPDATE waba_webhook_queue
				 SET
					status = ?,
					retry_count = ?,
					error = ?,
					processed_at = ?,
					updated_at = NOW(3)
				 WHERE id = ?`,
				shouldRetry ? WABA_QUEUE_STATUS.PENDING : WABA_QUEUE_STATUS.FAILED,
				newRetryCount,
				errorMessage,
				shouldRetry ? null : new Date(),
				id
			);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private stringifyPayload(payload: unknown): string {
		try {
			return JSON.stringify(payload);
		} catch (_err) {
			return JSON.stringify({ invalidPayload: true });
		}
	}

	private parsePayload(payload: unknown): unknown {
		if (typeof payload === "string") {
			try {
				return JSON.parse(payload);
			} catch (_err) {
				return payload;
			}
		}

		return payload;
	}

	private async markAsProcessingAndGet(id: string): Promise<WABAWebhookQueueRow | null> {
		const updated = await prismaService.$executeRawUnsafe(
			`UPDATE waba_webhook_queue
			 SET status = ?, processing_started_at = NOW(3), updated_at = NOW(3)
			 WHERE id = ? AND status = ?`,
			WABA_QUEUE_STATUS.PROCESSING,
			id,
			WABA_QUEUE_STATUS.PENDING
		);

		if (!updated) {
			return null;
		}

		const rows = await prismaService.$queryRawUnsafe<WABAWebhookQueueRow[]>(
			`SELECT
				id,
				instance,
				payload,
				retry_count AS retryCount,
				max_retries AS maxRetries
			 FROM waba_webhook_queue
			 WHERE id = ?
			 LIMIT 1`,
			id
		);

		return rows[0] || null;
	}

	public async getStats() {
		const rows = await prismaService.$queryRawUnsafe<Array<{ status: WABAQueueStatus; total: bigint | number }>>(
			`SELECT status, COUNT(*) AS total
			 FROM waba_webhook_queue
			 GROUP BY status`
		);

		const totals = {
			pending: 0,
			processing: 0,
			completed: 0,
			failed: 0,
			ignored: 0
		};

		for (const row of rows) {
			const count = typeof row.total === "bigint" ? Number(row.total) : row.total;
			switch (row.status) {
				case WABA_QUEUE_STATUS.PENDING:
					totals.pending = count;
					break;
				case WABA_QUEUE_STATUS.PROCESSING:
					totals.processing = count;
					break;
				case WABA_QUEUE_STATUS.COMPLETED:
					totals.completed = count;
					break;
				case WABA_QUEUE_STATUS.FAILED:
					totals.failed = count;
					break;
				case WABA_QUEUE_STATUS.IGNORED:
					totals.ignored = count;
					break;
			}
		}

		return { ...totals, activeProcessing: this.activeProcessing };
	}

	public async retryFailed(): Promise<number> {
		const result = await prismaService.$executeRawUnsafe(
			`UPDATE waba_webhook_queue
			 SET
				status = ?,
				retry_count = 0,
				error = NULL,
				processed_at = NULL,
				processing_started_at = NULL,
				updated_at = NOW(3)
			 WHERE status = ?`,
			WABA_QUEUE_STATUS.PENDING,
			WABA_QUEUE_STATUS.FAILED
		);

		return typeof result === "number" ? result : Number(result);
	}
}

export default new WABAWebhookQueueService();
