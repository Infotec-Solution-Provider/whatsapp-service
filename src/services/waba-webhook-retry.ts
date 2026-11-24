import { isAxiosError } from "axios";
import { MessageReactionError } from "../utils/message-reaction";

const RECEIPT_LOOKUP_WINDOW_SECONDS = 15 * 60;
const PERMANENT_ERRORS = new Set([
	"WABA_MESSAGE_IDENTITY_MISMATCH",
	"WABA_REACTION_CHANNEL_REQUIRED",
	"WABA_REACTION_CHANNEL_MISMATCH"
]);

export function decideWabaWebhookRetry(error: unknown, attempts: number, maxAttempts: number, ageSeconds: number) {
	const reconciliation = error instanceof Error && (
		error.name === "MessageStatusTargetNotFoundError" || error.message === "WABA_REACTION_RECEIPT_NOT_FOUND"
	);
	if (reconciliation) {
		return {
			retry: ageSeconds < RECEIPT_LOOKUP_WINDOW_SECONDS && attempts < maxAttempts,
			code: "WABA_RECEIPT_RECONCILIATION_REQUIRED"
		};
	}

	const unsupportedSocketEvent = isAxiosError<{ message?: unknown }>(error) &&
		error.response?.status === 400 && error.response.data?.message === "Invalid event type.";
	const permanent = unsupportedSocketEvent ||
		(error instanceof MessageReactionError && error.code === "INVALID_REACTION") ||
		(error instanceof Error && PERMANENT_ERRORS.has(error.message));
	return { retry: !permanent && attempts < maxAttempts, code: null };
}
