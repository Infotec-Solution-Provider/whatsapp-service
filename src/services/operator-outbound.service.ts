import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { Logger } from "@in.pulse-crm/utils";
import PrismaOperatorOutboundRepository from "./operator-outbound.repository";
import {
	OperatorOutboundDeliveryResult,
	OperatorOutboundEnqueueInput,
	OperatorOutboundHandler,
	OperatorOutboundItem,
	OperatorOutboundRepository,
	OperatorOutboundRequestError,
	OperatorOutboundScope,
} from "./operator-outbound.types";

export * from "./operator-outbound.types";

interface OperatorOutboundServiceOptions {
	now?: () => Date;
	intervalMs?: number;
	lockMs?: number;
	retryMs?: number;
	concurrency?: number;
	maxRemoteAttempts?: number;
	maxRemotePendingAgeMs?: number;
	/** Must remain below the remote provider's shortest idempotency retention. */
	maxUnacknowledgedRemoteAgeMs?: number;
	onError?: (error: unknown) => void;
}

export class OperatorOutboundService {
	private handler: OperatorOutboundHandler | null = null;
	private timer: NodeJS.Timeout | null = null;
	private processing = false;
	private readonly now: () => Date;
	private readonly intervalMs: number;
	private readonly lockMs: number;
	private readonly retryMs: number;
	private readonly concurrency: number;
	private readonly maxRemoteAttempts: number;
	private readonly maxRemotePendingAgeMs: number;
	private readonly maxUnacknowledgedRemoteAgeMs: number;
	private readonly onError: (error: unknown) => void;

	constructor(private readonly repository: OperatorOutboundRepository, options: OperatorOutboundServiceOptions = {}) {
		this.now = options.now ?? (() => new Date());
		this.intervalMs = options.intervalMs ?? 500;
		this.lockMs = options.lockMs ?? 60_000;
		this.retryMs = options.retryMs ?? 2_000;
		const configuredConcurrency = options.concurrency ?? Number(process.env["OPERATOR_OUTBOUND_CONCURRENCY"] ?? 4);
		this.concurrency = Math.min(8, Math.max(1, Math.floor(Number.isFinite(configuredConcurrency) ? configuredConcurrency : 4)));
		this.maxRemoteAttempts = options.maxRemoteAttempts ?? 10;
		this.maxRemotePendingAgeMs = options.maxRemotePendingAgeMs ?? 5 * 60 * 1_000;
		this.maxUnacknowledgedRemoteAgeMs = options.maxUnacknowledgedRemoteAgeMs ?? 23 * 60 * 60 * 1_000;
		this.onError = options.onError ?? ((error) => Logger.error("[OperatorOutbound] Processing failed", error as Error));
	}

	setHandler(handler: OperatorOutboundHandler): void { this.handler = handler; }

	async enqueue(input: OperatorOutboundEnqueueInput) {
		if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 191 || !/^[a-f0-9]{64}$/i.test(input.payloadHash)) {
			throw new OperatorOutboundRequestError("Chave de envio ou hash de conteúdo inválido.", 400);
		}
		// No socket, legacy synchronization or provider call can prevent the durable ACK.
		return this.repository.enqueue(input);
	}

	lookup(scope: OperatorOutboundScope, key: string) { return this.repository.lookup(scope, key); }

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
		if (this.processing || !this.handler) return;
		this.processing = true;
		try {
			await this.repository.recoverExpired(this.now());
			const ids = await this.repository.candidates(this.now(), 20);
			await this.runBounded(ids, (id) => this.processItem(id));
			const notifications = await this.repository.notificationCandidates(this.now(), 20);
			await this.runBounded(notifications, (id) => this.notify(id));
		} catch (error) {
			this.onError(error);
		} finally {
			this.processing = false;
		}
	}

	private async processItem(id: string): Promise<void> {
		const token = randomUUID();
		let heartbeat: NodeJS.Timeout | null = null;
		try {
			const now = this.now();
			const item = await this.repository.claim(id, token, now, new Date(now.getTime() + this.lockMs));
			if (!item || !this.handler) return;
			heartbeat = this.heartbeat(id, token);
			if (!item.providerOutcome) {
				let outcome: OperatorOutboundDeliveryResult;
				let attemptedItem = item;
				const stopped = this.remoteRetryLimit(item);
				if (stopped) {
					outcome = stopped;
				} else {
					if (this.handler.preflight && !await this.handler.preflight(item)) {
						await this.repository.deferBeforeAttempt(id, token, new Date(this.now().getTime() + this.retryMs));
						return;
					}
					// Commit intent BEFORE entering the provider. A restart between these
					// operations is deliberately UNKNOWN for a non-idempotent provider.
					const attemptTime = this.now();
					if (!await this.repository.markAttemptStarted(id, token, attemptTime)) return;
					attemptedItem = { ...item, attemptCount: item.attemptCount + 1, attemptStartedAt: item.attemptStartedAt ?? attemptTime };
					try {
						outcome = await this.handler.deliver(item);
					} catch (error) {
						outcome = {
							status: item.deliveryMode === "DIRECT" ? "UNKNOWN" : "PENDING",
							error: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
						};
					}
				}
				if (outcome.status === "PENDING") {
					if (item.deliveryMode === "DIRECT") {
						outcome = { ...outcome, status: "UNKNOWN", error: outcome.error ?? "O provedor não confirmou o resultado do envio." };
					} else {
						// Recheck after the call: the final allowed attempt or a slow
						// response must not schedule yet another remote request.
						const exhausted = this.remoteRetryLimit({
							...attemptedItem, remoteJobId: outcome.remoteJobId ?? item.remoteJobId,
							error: outcome.error ?? item.error,
						});
						if (exhausted) {
							outcome = exhausted;
						} else {
							await this.repository.defer(id, token, outcome, new Date(this.now().getTime() + this.remoteRetryDelay(attemptedItem.attemptCount)));
							return;
						}
					}
				}
				// Durable provider receipt precedes local finalization and notification.
				// If persisting it fails, keep the lease; DIRECT recovery cannot resend.
				if (!await this.repository.recordOutcome(id, token, outcome)) return;
			}
			await this.repository.complete(id, token, this.handler.finalize);
		} catch (error) {
			this.onError(error);
		} finally {
			if (heartbeat) clearInterval(heartbeat);
		}
	}

	private remoteRetryLimit(item: OperatorOutboundItem): OperatorOutboundDeliveryResult | null {
		if (item.deliveryMode !== "REMOTE") return null;
		const age = item.attemptStartedAt === null ? 0 : this.now().getTime() - item.attemptStartedAt.getTime();
		let reason: string;
		if (item.attemptCount >= this.maxRemoteAttempts) {
			reason = "Limite de tentativas de confirmação do envio atingido.";
		} else if (item.attemptStartedAt !== null && age >= this.maxRemotePendingAgeMs) {
			reason = "Prazo de confirmação do envio esgotado.";
		} else if (!item.remoteJobId && item.attemptStartedAt !== null && age >= this.maxUnacknowledgedRemoteAgeMs) {
			reason = "Não foi possível confirmar o envio dentro da janela segura de idempotência do provedor.";
		} else {
			return null;
		}
		return {
			status: "UNKNOWN",
			...(item.remoteJobId ? { remoteJobId: item.remoteJobId } : {}),
			error: `${reason} Reenvio automático bloqueado.${item.error ? ` Último erro: ${item.error}` : ""}`.slice(0, 4_000),
		};
	}

	private remoteRetryDelay(attemptCount: number): number {
		return Math.min(30_000, this.retryMs * 2 ** Math.min(10, Math.max(0, attemptCount - 1)));
	}

	private async runBounded(ids: string[], process: (id: string) => Promise<void>): Promise<void> {
		for (let offset = 0; offset < ids.length; offset += this.concurrency) {
			await Promise.all(ids.slice(offset, offset + this.concurrency).map(process));
		}
	}

	private heartbeat(id: string, token: string): NodeJS.Timeout {
		let running = false;
		const timer = setInterval(() => {
			if (running) return;
			running = true;
			const now = this.now();
			void this.repository.renew(id, token, now, new Date(now.getTime() + this.lockMs))
				.catch(this.onError).finally(() => { running = false; });
		}, Math.max(100, Math.floor(this.lockMs / 3)));
		timer.unref();
		return timer;
	}

	private async notify(id: string): Promise<void> {
		const token = randomUUID();
		let heartbeat: NodeJS.Timeout | null = null;
		try {
			const now = this.now();
			const item = await this.repository.claimNotification(id, token, now, new Date(now.getTime() + this.lockMs));
			if (!item || !this.handler) return;
			heartbeat = this.heartbeat(id, token);
			let success = false;
			try {
				await this.handler.onMessage(item.message, item.payload as Prisma.JsonValue);
				success = true;
			} catch (error) { this.onError(error); }
			await this.repository.finishNotification(id, token, success, new Date(this.now().getTime() + this.retryMs));
		} catch (error) { this.onError(error); }
		finally { if (heartbeat) clearInterval(heartbeat); }
	}
}

export default new OperatorOutboundService(new PrismaOperatorOutboundRepository());
