const CALLBACK_PREFIX = "inpulse:health-probe:v1:";
const CORRELATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createFunctionalHealthCallbackData(clientId: number, correlationId: string): string {
	if (!Number.isSafeInteger(clientId) || clientId <= 0 || !CORRELATION_ID_PATTERN.test(correlationId)) {
		throw new Error("Invalid functional health callback identity");
	}
	return `${CALLBACK_PREFIX}${clientId}:${correlationId}`;
}

/** The callback travels with the webhook, surviving probe cleanup, queue delays and restarts. */
export function isFunctionalHealthStatus(clientId: number, callbackData: unknown): boolean {
	if (typeof callbackData !== "string") return false;
	const prefix = `${CALLBACK_PREFIX}${clientId}:`;
	return callbackData.startsWith(prefix) && CORRELATION_ID_PATTERN.test(callbackData.slice(prefix.length));
}
