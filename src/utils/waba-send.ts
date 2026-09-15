type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
	return typeof value === "object" && value !== null ? value as RecordValue : undefined;
}

function safeText(value: unknown, max = 700): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value
		.replace(/(["']?(?:access_token|refresh_token|authorization|password|token)["']?\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&;,}]+)/gi, "$1[redacted]")
		.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.replace(/[\r\n\t]+/g, " ").slice(0, max);
}

export interface WabaErrorDetails {
	httpStatus?: number;
	code?: number;
	subcode?: number;
	message?: string;
	traceId?: string;
	transportCode?: string;
}

/** Carries only safe diagnostics; never retain Axios config, headers, or request. */
export class WabaDeliveryError extends Error {
	constructor(
		public readonly deliveryStatus: "FAILED" | "UNKNOWN",
		message: string,
		public readonly details: WabaErrorDetails = {},
	) {
		super(message);
		this.name = "WabaDeliveryError";
	}
}

function metaDetails(error: unknown): { details: WabaErrorDetails; transient: boolean; hasReceipt: boolean } {
	const source = record(error);
	const response = record(source?.["response"]);
	const data = record(response?.["data"]);
	const meta = record(data?.["error"]);
	const details: WabaErrorDetails = {};
	if (typeof response?.["status"] === "number") details.httpStatus = response["status"];
	if (typeof meta?.["code"] === "number") details.code = meta["code"];
	if (typeof meta?.["error_subcode"] === "number") details.subcode = meta["error_subcode"];
	const message = safeText(meta?.["message"]);
	const trace = safeText(meta?.["fbtrace_id"], 120);
	const transport = source?.["code"];
	if (message) details.message = message;
	if (trace) details.traceId = trace;
	if (typeof transport === "string" && /^[A-Z][A-Z0-9_]{0,49}$/.test(transport)) details.transportCode = transport;
	const messages = data?.["messages"];
	return { details, transient: meta?.["is_transient"] === true,
		hasReceipt: Array.isArray(messages) && messages.some((m) => typeof record(m)?.["id"] === "string") };
}

function diagnosticSuffix(details: WabaErrorDetails): string {
	const parts = [details.code === undefined ? undefined : `Meta ${details.code}`,
		details.subcode === undefined ? undefined : `subcódigo ${details.subcode}`,
		details.traceId ? `referência ${details.traceId}` : undefined,
		details.transportCode];
	const text = parts.filter(Boolean).join("; ");
	return text ? ` (${text})` : "";
}

export function classifyWabaSendError(error: unknown): WabaDeliveryError {
	if (error instanceof WabaDeliveryError) return error;
	const { details, transient, hasReceipt } = metaDetails(error);
	// A gateway error, timeout or transient provider failure is not proof of rejection.
	const rejected = !hasReceipt && !transient && details.httpStatus !== undefined
		&& details.httpStatus >= 400 && details.httpStatus < 500 && details.httpStatus !== 408
		&& details.code !== undefined && !!details.message && ![1, 2, 131000, 131016].includes(details.code);
	const reason = details.code === 100 && /not a valid whatsapp business account media attachment id/i.test(details.message ?? "")
		? "O anexo foi recusado porque a mídia é inválida ou expirou."
		: `A Meta recusou o envio: ${details.message}`;
	const message = rejected
		? `${reason}${diagnosticSuffix(details)}`
		: `Não foi possível confirmar o envio pelo WhatsApp oficial. Consulte o resultado antes de reenviar.${diagnosticSuffix(details)}`;
	return new WabaDeliveryError(rejected ? "FAILED" : "UNKNOWN", message, details);
}

export function wabaPreparationError(error: unknown): WabaDeliveryError {
	const { details } = metaDetails(error);
	return new WabaDeliveryError("FAILED",
		`Não foi possível preparar o anexo ou a mensagem para o WhatsApp oficial. Nenhuma mensagem foi enviada.${diagnosticSuffix(details)}`, details);
}

function invalidMediaType(error: WabaDeliveryError): string | undefined {
	if (error.deliveryStatus !== "FAILED" || error.details.code !== 100) return undefined;
	const message = error.details.message ?? "";
	if (!/not a valid whatsapp business account media attachment id/i.test(message)) return undefined;
	return /\b(image|video|audio|document|sticker)\.id\b/i.exec(message)?.[1]?.toLowerCase();
}

/** A second send is permitted only after a matching, explicit invalid-media rejection. */
export async function sendWabaRequest(
	send: () => Promise<unknown>,
	media?: { type: string; renew: (rejection: WabaDeliveryError) => Promise<void> },
): Promise<{ id: string; data: unknown }> {
	for (let attempt = 0; ; attempt++) {
		let data: unknown;
		try {
			data = await send();
		} catch (error) {
			const failure = classifyWabaSendError(error);
			if (attempt === 0 && media && invalidMediaType(failure) === media.type) {
				try { await media.renew(failure); }
				catch (renewError) {
					if (renewError instanceof WabaDeliveryError) throw renewError;
					throw wabaPreparationError(renewError);
				}
				continue;
			}
			throw failure;
		}
		const messages = record(data)?.["messages"];
		const id = Array.isArray(messages) ? record(messages[0])?.["id"] : undefined;
		if (typeof id !== "string" || !id.trim()) {
			throw new WabaDeliveryError("UNKNOWN", "A Meta respondeu sem um identificador de mensagem. Consulte o resultado antes de reenviar.");
		}
		return { id, data };
	}
}
