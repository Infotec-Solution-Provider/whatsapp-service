import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";

function safeStringify(value: unknown) {
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify({ serializationError: true, value: String(value) });
	}
}

export function resolveUploadTraceId(...candidates: unknown[]) {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}

		if (Array.isArray(candidate)) {
			for (const item of candidate) {
				if (typeof item === "string" && item.trim()) {
					return item.trim();
				}
			}
		}
	}

	return `ws-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createUploadTraceLogger(service: string, traceId: string) {
	const startedAt = Date.now();

	return {
		traceId,
		info(stage: string, details?: unknown) {
			const suffix = details === undefined ? "" : ` | details=${safeStringify(details)}`;
			Logger.info(`[file-trace][${service}][${traceId}][+${Date.now() - startedAt}ms] ${stage}${suffix}`);
		},
		error(stage: string, error: unknown, details?: unknown) {
			const suffix = details === undefined ? "" : ` | details=${safeStringify(details)}`;
			Logger.error(
				`[file-trace][${service}][${traceId}][+${Date.now() - startedAt}ms] ${stage} | error=${sanitizeErrorMessage(error)}${suffix}`,
				error as Error,
			);
		},
	};
}