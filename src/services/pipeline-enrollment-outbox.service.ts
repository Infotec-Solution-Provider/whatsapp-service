import axios from "axios";
import { hostname } from "node:os";
import { Logger } from "@in.pulse-crm/utils";
import prismaService from "./prisma.service";

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_LOCK_MS = 60_000;

export function pipelineEnrollmentRetryDelayMs(retryCount: number): number {
	return Math.min(300_000, 1_000 * 2 ** Math.min(Math.max(retryCount, 0), 8));
}

class PipelineEnrollmentOutboxService {
	private readonly workerId = `${hostname()}-${process.pid}-pipeline-enrollment`;
	private readonly intervalMs = Math.max(100, Number(process.env["PIPELINE_EVENTS_INTERVAL_MS"] || DEFAULT_INTERVAL_MS));
	private readonly lockMs = Math.max(5_000, Number(process.env["PIPELINE_EVENTS_LOCK_MS"] || DEFAULT_LOCK_MS));
	private timer: NodeJS.Timeout | null = null;
	private processing = false;

	startWorker(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.processOnce(), this.intervalMs);
		this.timer.unref();
		void this.processOnce();
	}

	stopWorker(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async processOnce(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			await prismaService.pipelineEnrollmentOutbox.updateMany({
				where: { status: "PROCESSING", lockedUntil: { lt: new Date() } },
				data: { status: "PENDING", lockedUntil: null, lockedBy: null, processingStartedAt: null, nextAttemptAt: new Date() },
			});
			const candidates = await prismaService.pipelineEnrollmentOutbox.findMany({
				where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
				orderBy: { createdAt: "asc" },
				take: 20,
			});
			await Promise.all(candidates.map((candidate) => this.claimAndDeliver(candidate.id)));
		} catch (error) {
			Logger.error("[PipelineEnrollmentOutbox] Processing loop failed", error as Error);
		} finally {
			this.processing = false;
		}
	}

	private async claimAndDeliver(id: string): Promise<void> {
		const claimed = await prismaService.pipelineEnrollmentOutbox.updateMany({
			where: { id, status: "PENDING", nextAttemptAt: { lte: new Date() } },
			data: {
				status: "PROCESSING",
				lockedBy: this.workerId,
				lockedUntil: new Date(Date.now() + this.lockMs),
				processingStartedAt: new Date(),
			},
		});
		if (claimed.count !== 1) return;
		const item = await prismaService.pipelineEnrollmentOutbox.findUnique({ where: { id } });
		if (!item) return;

		try {
			const baseUrl = (process.env["MARKETING_API_URL"] || "http://localhost:8007").replace(/\/$/, "");
			await axios.post(
				`${baseUrl}/api/internal/marketing/pipeline-events`,
				{
					eventId: item.idempotencyKey,
					instance: item.instance,
					sourceType: item.sourceType,
					sourceKey: item.sourceKey,
					messageId: item.messageId,
					contactId: item.contactId,
					customerId: item.customerId,
				},
				{
					timeout: 15_000,
					headers: { "Idempotency-Key": item.idempotencyKey },
				},
			);
			await prismaService.pipelineEnrollmentOutbox.updateMany({
				where: { id, status: "PROCESSING", lockedBy: this.workerId },
				data: { status: "COMPLETED", completedAt: new Date(), error: null, lockedUntil: null, lockedBy: null },
			});
		} catch (error) {
			const status = axios.isAxiosError(error) ? error.response?.status : undefined;
			const permanent = typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
			const retryCount = item.retryCount + 1;
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
			await prismaService.pipelineEnrollmentOutbox.updateMany({
				where: { id, status: "PROCESSING", lockedBy: this.workerId },
				data: {
					status: permanent ? "FAILED" : "PENDING",
					retryCount,
					error: message,
					nextAttemptAt: new Date(Date.now() + pipelineEnrollmentRetryDelayMs(retryCount)),
					lockedUntil: null,
					lockedBy: null,
				},
			});
			Logger.error(`[PipelineEnrollmentOutbox] Delivery failed for ${id}: ${message}`, error as Error);
		}
	}
}

export default new PipelineEnrollmentOutboxService();
