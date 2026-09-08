import { Prisma, PrismaClient, WppMessage } from "@prisma/client";
import prismaService from "./prisma.service";
import {
	assertOperatorOutboundReplay,
	OperatorOutboundDeliveryResult,
	OperatorOutboundEnqueueInput,
	OperatorOutboundEnqueueResult,
	OperatorOutboundHandler,
	OperatorOutboundRepository,
	OperatorOutboundScope,
} from "./operator-outbound.types";

const TERMINAL_STATES = ["SENT", "FAILED", "UNKNOWN"] as const;
const CONFIRMED_MESSAGE_STATES = ["SENT", "RECEIVED", "READ", "DOWNLOADED", "REVOKED"] as const;

function json(value: unknown): Prisma.InputJsonValue {
	return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Provider data cannot change operator scope, recipient, draft or chat ownership. */
export function operatorOutboundProviderFields(result: Partial<WppMessage> | undefined): Prisma.WppMessageUncheckedUpdateInput {
	if (!result) return {};
	const patch: Prisma.WppMessageUncheckedUpdateInput = {};
	for (const key of ["wwebjsId", "wwebjsIdStanza", "wabaId", "gupshupId", "gupshupRequestId"] as const) {
		const value = result[key];
		if (typeof value === "string" && value) patch[key] = value;
	}
	return patch;
}

export default class PrismaOperatorOutboundRepository implements OperatorOutboundRepository {
	constructor(private readonly db: PrismaClient = prismaService) {}

	async lookup(scope: OperatorOutboundScope, key: string) {
		const item = await this.db.operatorOutboundSend.findUnique({
			where: { instance_userId_idempotencyKey: { instance: scope.instance, userId: scope.userId, idempotencyKey: key } },
			include: { message: true },
		});
		if (!item) return null;
		const { message, ...job } = item;
		return { message, job };
	}

	async enqueue(input: OperatorOutboundEnqueueInput): Promise<OperatorOutboundEnqueueResult> {
		const existing = await this.lookup(input, input.idempotencyKey);
		if (existing) {
			assertOperatorOutboundReplay(existing.job, input);
			return { ...existing, created: false };
		}
		try {
			return await this.db.$transaction(async (tx) => {
				const message = await tx.wppMessage.create({
					data: { ...input.message, instance: input.instance, userId: input.userId, clientId: input.clientId, status: "PENDING" },
				});
				const job = await tx.operatorOutboundSend.create({
					data: {
						instance: input.instance, userId: input.userId, clientId: input.clientId,
						idempotencyKey: input.idempotencyKey, payloadHash: input.payloadHash,
						payload: input.payload, messageId: message.id, deliveryMode: input.deliveryMode,
					},
				});
				return { message, job, created: true };
			});
		} catch (error) {
			if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
			// The losing transaction rolled back its message too; replay the winner.
			const raced = await this.lookup(input, input.idempotencyKey);
			if (!raced) throw error;
			assertOperatorOutboundReplay(raced.job, input);
			return { ...raced, created: false };
		}
	}

	async recoverExpired(now: Date): Promise<void> {
		const expired = await this.db.operatorOutboundSend.findMany({
			where: { status: "PROCESSING", lockedUntil: { lte: now } },
			orderBy: { lockedUntil: "asc" }, take: 100,
		});
		for (const item of expired) {
			await this.db.$transaction(async (tx) => {
				// Re-read the receipt under a row lock: an old worker may have saved a
				// confirmed result since the candidate snapshot was obtained.
				const locked = await tx.operatorOutboundSend.updateMany({
					where: { id: item.id, status: "PROCESSING", lockedBy: item.lockedBy, lockedUntil: { lte: now } },
					data: { updatedAt: now },
				});
				if (locked.count !== 1) return;
				const current = await tx.operatorOutboundSend.findUniqueOrThrow({ where: { id: item.id } });
				const unknown = current.deliveryMode === "DIRECT" && current.attemptStartedAt && !current.providerOutcome;
				await tx.operatorOutboundSend.update({
					where: { id: item.id },
					data: {
						status: "PENDING", lockedBy: null, lockedUntil: null, nextAttemptAt: now,
						...(unknown ? { providerOutcome: json({ status: "UNKNOWN", error: "Envio interrompido após registrar a tentativa; reenvio automático bloqueado." }) } : {}),
					},
				});
			});
		}
	}

	async candidates(now: Date, limit: number): Promise<string[]> {
		const rows = await this.db.operatorOutboundSend.findMany({
			where: { status: "PENDING", nextAttemptAt: { lte: now } },
			orderBy: { createdAt: "asc" }, take: limit, select: { id: true },
		});
		return rows.map((row) => row.id);
	}

	async claim(id: string, token: string, now: Date, lockedUntil: Date) {
		const updated = await this.db.operatorOutboundSend.updateMany({
			where: { id, status: "PENDING", nextAttemptAt: { lte: now } },
			data: { status: "PROCESSING", lockedBy: token, lockedUntil },
		});
		if (updated.count !== 1) return null;
		return this.db.operatorOutboundSend.findUnique({ where: { id }, include: { message: true } });
	}

	async markAttemptStarted(id: string, token: string, now: Date): Promise<boolean> {
		// attemptStartedAt records the FIRST submission, bounding retries by remote
		// retention. The first write is fenced by the still-valid ownership lease.
		return this.db.$transaction(async (tx) => {
			const claimed = await tx.operatorOutboundSend.updateMany({
				where: { id, status: "PROCESSING", lockedBy: token, lockedUntil: { gt: now } },
				data: { attemptCount: { increment: 1 } },
			});
			if (claimed.count !== 1) return false;
			await tx.operatorOutboundSend.updateMany({
				where: { id, lockedBy: token, attemptStartedAt: null }, data: { attemptStartedAt: now },
			});
			return true;
		});
	}

	async renew(id: string, token: string, now: Date, lockedUntil: Date): Promise<void> {
		await this.db.operatorOutboundSend.updateMany({
			where: { id, lockedBy: token, lockedUntil: { gt: now } }, data: { lockedUntil },
		});
	}

	async recordOutcome(id: string, token: string, outcome: OperatorOutboundDeliveryResult): Promise<boolean> {
		const updated = await this.db.operatorOutboundSend.updateMany({
			where: { id, status: "PROCESSING", lockedBy: token },
			data: { providerOutcome: json(outcome), ...(outcome.remoteJobId ? { remoteJobId: outcome.remoteJobId } : {}) },
		});
		return updated.count === 1;
	}

	async defer(id: string, token: string, outcome: OperatorOutboundDeliveryResult, nextAttemptAt: Date): Promise<void> {
		await this.db.operatorOutboundSend.updateMany({
			where: { id, status: "PROCESSING", lockedBy: token, deliveryMode: "REMOTE" },
			data: {
				status: "PENDING", lockedBy: null, lockedUntil: null, nextAttemptAt,
				error: outcome.error?.slice(0, 4_000) ?? null,
				...(outcome.remoteJobId ? { remoteJobId: outcome.remoteJobId } : {}),
			},
		});
	}

	async deferBeforeAttempt(id: string, token: string, nextAttemptAt: Date): Promise<void> {
		await this.db.operatorOutboundSend.updateMany({
			where: {
				id, status: "PROCESSING", lockedBy: token,
				OR: [{ deliveryMode: "REMOTE" }, { deliveryMode: "DIRECT", attemptStartedAt: null }],
			},
			data: { status: "PENDING", lockedBy: null, lockedUntil: null, nextAttemptAt },
		});
	}

	async complete(id: string, token: string, finalize: OperatorOutboundHandler["finalize"]): Promise<void> {
		await this.db.$transaction(async (tx) => {
			// Lock job before reading its receipt; stale workers cannot finalize it.
			const owned = await tx.operatorOutboundSend.updateMany({
				where: { id, status: "PROCESSING", lockedBy: token }, data: { updatedAt: new Date() },
			});
			if (owned.count !== 1) return;
			const job = await tx.operatorOutboundSend.findUniqueOrThrow({ where: { id } });
			if (!job.providerOutcome) throw new Error("Cannot finalize without a durable provider outcome");
			const outcome = job.providerOutcome as unknown as OperatorOutboundDeliveryResult;
			if (outcome.status === "PENDING") throw new Error("A pending provider job cannot be finalized");
			await tx.wppMessage.update({ where: { id: job.messageId }, data: operatorOutboundProviderFields(outcome.result) });
			// SQL predicate uses the current row, even if an ACK arrived during this
			// transaction. Confirmed delivery/read/download/revoke never regresses.
			await tx.wppMessage.updateMany({
				where: { id: job.messageId, status: { notIn: [...CONFIRMED_MESSAGE_STATES] } },
				data: { status: outcome.status === "FAILED" ? "ERROR" : outcome.status },
			});
			const message = await tx.wppMessage.findUniqueOrThrow({ where: { id: job.messageId } });
			const confirmed = (CONFIRMED_MESSAGE_STATES as readonly string[]).includes(message.status);
			const status = confirmed ? "SENT" : outcome.status;
			if (status === "SENT" && finalize) await finalize(tx, message, job.payload);
			await tx.operatorOutboundSend.update({
				where: { id },
				data: {
					status, error: confirmed ? null : outcome.error?.slice(0, 4_000) ?? null,
					completedAt: new Date(), lockedBy: null, lockedUntil: null,
					notificationPending: true, nextAttemptAt: new Date(),
				},
			});
		});
	}

	async notificationCandidates(now: Date, limit: number): Promise<string[]> {
		const rows = await this.db.operatorOutboundSend.findMany({
			where: {
				status: { in: [...TERMINAL_STATES] }, notificationPending: true, nextAttemptAt: { lte: now },
				OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
			},
			orderBy: { nextAttemptAt: "asc" }, take: limit, select: { id: true },
		});
		return rows.map((row) => row.id);
	}

	async claimNotification(id: string, token: string, now: Date, lockedUntil: Date) {
		const claimed = await this.db.operatorOutboundSend.updateMany({
			where: {
				id, status: { in: [...TERMINAL_STATES] }, notificationPending: true, nextAttemptAt: { lte: now },
				OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
			},
			data: { lockedBy: token, lockedUntil },
		});
		if (claimed.count !== 1) return null;
		return this.db.operatorOutboundSend.findUnique({ where: { id }, include: { message: true } });
	}

	async finishNotification(id: string, token: string, success: boolean, nextAttemptAt: Date): Promise<void> {
		await this.db.operatorOutboundSend.updateMany({
			where: { id, lockedBy: token, status: { in: [...TERMINAL_STATES] } },
			data: { notificationPending: !success, lockedBy: null, lockedUntil: null, nextAttemptAt },
		});
	}
}
