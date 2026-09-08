import type { OperatorOutboundSend, Prisma, WppMessage } from "@prisma/client";

export class OperatorOutboundRequestError extends Error {
	constructor(message: string, public readonly statusCode: 400 | 409) {
		super(message);
		this.name = "OperatorOutboundRequestError";
	}
}

export interface OperatorOutboundScope {
	instance: string;
	userId: number;
}

export interface OperatorOutboundEnqueueInput extends OperatorOutboundScope {
	clientId: number;
	idempotencyKey: string;
	payloadHash: string;
	message: Prisma.WppMessageUncheckedCreateInput;
	payload: Prisma.InputJsonObject;
	deliveryMode: "REMOTE" | "DIRECT";
}

export type OperatorOutboundItem = OperatorOutboundSend & { message: WppMessage };

export interface OperatorOutboundRecord {
	job: OperatorOutboundSend;
	message: WppMessage;
}

export type OperatorOutboundEnqueueResult = OperatorOutboundRecord & { created: boolean };

export interface OperatorOutboundDeliveryResult {
	status: "PENDING" | "SENT" | "FAILED" | "UNKNOWN";
	remoteJobId?: string;
	result?: Partial<WppMessage>;
	error?: string;
}

export interface OperatorOutboundHandler {
	/** Returning false defers work before entering a provider; no attempt is recorded. */
	preflight?(item: OperatorOutboundItem): Promise<boolean>;
	deliver(item: OperatorOutboundItem): Promise<OperatorOutboundDeliveryResult>;
	onMessage(message: WppMessage, payload: Prisma.JsonValue): Promise<void>;
	/** Database-only effects, committed atomically with SENT. Must be idempotent. */
	finalize?(tx: Prisma.TransactionClient, message: WppMessage, payload: Prisma.JsonValue): Promise<void>;
}

export interface OperatorOutboundRepository {
	enqueue(input: OperatorOutboundEnqueueInput): Promise<OperatorOutboundEnqueueResult>;
	lookup(scope: OperatorOutboundScope, key: string): Promise<OperatorOutboundRecord | null>;
	recoverExpired(now: Date): Promise<void>;
	candidates(now: Date, limit: number): Promise<string[]>;
	claim(id: string, token: string, now: Date, lockedUntil: Date): Promise<OperatorOutboundItem | null>;
	markAttemptStarted(id: string, token: string, now: Date): Promise<boolean>;
	renew(id: string, token: string, now: Date, lockedUntil: Date): Promise<void>;
	recordOutcome(id: string, token: string, outcome: OperatorOutboundDeliveryResult): Promise<boolean>;
	defer(id: string, token: string, outcome: OperatorOutboundDeliveryResult, nextAttemptAt: Date): Promise<void>;
	deferBeforeAttempt(id: string, token: string, nextAttemptAt: Date): Promise<void>;
	complete(id: string, token: string, finalize: OperatorOutboundHandler["finalize"]): Promise<void>;
	notificationCandidates(now: Date, limit: number): Promise<string[]>;
	claimNotification(id: string, token: string, now: Date, lockedUntil: Date): Promise<OperatorOutboundItem | null>;
	finishNotification(id: string, token: string, success: boolean, nextAttemptAt: Date): Promise<void>;
}

export function assertOperatorOutboundReplay(
	existing: Pick<OperatorOutboundSend, "payloadHash" | "clientId" | "deliveryMode">,
	input: Pick<OperatorOutboundEnqueueInput, "payloadHash" | "clientId" | "deliveryMode">,
): void {
	if (existing.payloadHash !== input.payloadHash || existing.clientId !== input.clientId || existing.deliveryMode !== input.deliveryMode) {
		throw new OperatorOutboundRequestError("Esta chave de envio já foi utilizada com outro conteúdo ou canal.", 409);
	}
}
