import type {
	RemoteMessageJobDiagnostics,
	RemoteMessageJobResponse
} from "../types/remote-client.types";

/** Outcome of an internal-group WhatsApp delivery, persisted in the queue payload. */
export interface InternalWppOutcome {
	kind: "NOT_SENT" | "FAILED" | "UNKNOWN";
	/** True only when the provider proved the message never left (resend cannot duplicate). */
	safeToResend: boolean;
	at: string;
	error?: string;
}

/** Retry hint attached to ERROR internal messages of WhatsApp-linked chats. */
export interface WhatsappRetryHint {
	allowed: boolean;
	requiresConfirmation: boolean;
	reason?: string;
}

export const INTERNAL_WPP_MAX_RETRY_GENERATIONS = 3;
export const INTERNAL_WPP_RETRY_COOLDOWN_MS = 10_000;

/** Generation 0 keeps the historical key; manual resends get a new remote job each. */
export function internalWppIdempotencyKey(instance: string, internalMessageId: number, generation = 0): string {
	const base = `${instance}:internal-message:${internalMessageId}`;
	return generation >= 1 ? `${base}:retry:${generation}` : base;
}

export function whatsappRetryHint(queue: {
	exists: boolean;
	retryGeneration?: number | undefined;
	outcome?: InternalWppOutcome | null | undefined;
}): WhatsappRetryHint {
	if (!queue.exists) return { allowed: false, requiresConfirmation: false, reason: "NO_QUEUE_ITEM" };
	if ((queue.retryGeneration ?? 0) >= INTERNAL_WPP_MAX_RETRY_GENERATIONS) {
		return { allowed: false, requiresConfirmation: false, reason: "RETRY_LIMIT" };
	}
	if (queue.outcome?.safeToResend === true) return { allowed: true, requiresConfirmation: false };
	return { allowed: true, requiresConfirmation: true };
}

/** Parse a queue payload JSON without trusting its shape. */
export function parseQueuePayload<T>(messageData: string | null | undefined): T | null {
	if (!messageData) return null;
	try {
		const value = JSON.parse(messageData) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
	} catch {
		return null;
	}
}

function isoOrNull(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/** Tolerant reader: picks only well-typed diagnostic fields from a remote job response. */
export function remoteJobDiagnostics(job: Partial<RemoteMessageJobResponse> | null | undefined): RemoteMessageJobDiagnostics {
	const source = (job || {}) as Record<string, unknown>;
	const duration = source["sendDurationMs"];
	const library = source["sendLibrary"];
	const failureKind = source["failureKind"];
	const sessionId = source["sendSessionId"];
	return {
		firstAttemptAt: isoOrNull(source["firstAttemptAt"]),
		processedAt: isoOrNull(source["processedAt"]),
		sendDurationMs: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
		sendSessionId: typeof sessionId === "string" && sessionId.length <= 191 ? sessionId : null,
		sendLibrary: library === "BAILEYS" || library === "ZAPO" ? library : null,
		fallback: typeof source["fallback"] === "boolean" ? (source["fallback"] as boolean) : null,
		failureKind: failureKind === "NOT_SENT" || failureKind === "ERROR" ? failureKind : null
	};
}

export type InternalWppJobVerdict =
	| { state: "PENDING"; reason: "IN_PROGRESS" | "VERIFYING" }
	| { state: "SENT" }
	| { state: "ERROR"; kind: InternalWppOutcome["kind"]; queueStatus: "FAILED" | "UNKNOWN"; error: string };

/** A receipt can still promote UNKNOWN to SENT; past this grace the deadline is not trusted. */
const VERIFYING_CLOCK_GRACE_MS = 5 * 60 * 1000;

/**
 * Maps a remote job to the internal message outcome.
 * PENDING/PROCESSING and UNKNOWN still inside its receipt window keep polling;
 * FAILED is provably-not-sent only when the provider says failureKind NOT_SENT.
 */
export function classifyInternalWppJob(job: RemoteMessageJobResponse, now = Date.now()): InternalWppJobVerdict {
	const fallbackError = `Remote job ${job.jobId} ended with status ${job.status}`;
	if (job.status === "PENDING" || job.status === "PROCESSING") return { state: "PENDING", reason: "IN_PROGRESS" };
	if (job.status === "SENT") {
		if (job.result) return { state: "SENT" };
		return { state: "ERROR", kind: "UNKNOWN", queueStatus: "UNKNOWN", error: `Remote job ${job.jobId} was sent without a result` };
	}
	if (job.status === "FAILED") {
		const notSent = remoteJobDiagnostics(job).failureKind === "NOT_SENT";
		return {
			state: "ERROR",
			kind: notSent ? "NOT_SENT" : "FAILED",
			queueStatus: "FAILED",
			error: job.error || fallbackError
		};
	}
	if (job.status === "UNKNOWN" && job.confirmationStatus === "VERIFYING") {
		const deadline = job.confirmationDeadlineAt ? new Date(job.confirmationDeadlineAt).getTime() : Number.NaN;
		if (Number.isNaN(deadline) || now <= deadline + VERIFYING_CLOCK_GRACE_MS) {
			return { state: "PENDING", reason: "VERIFYING" };
		}
	}
	return { state: "ERROR", kind: "UNKNOWN", queueStatus: "UNKNOWN", error: job.error || fallbackError };
}

export function outcomeErrorPrefix(kind: InternalWppOutcome["kind"]): string {
	return `[${kind}]`;
}
