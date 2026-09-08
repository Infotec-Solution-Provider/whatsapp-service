import { createHash } from "node:crypto";

export class OperatorSendRequestError extends Error {
	constructor(message: string, public readonly statusCode = 400) {
		super(message);
	}
}

export interface OperatorSendRequest {
	clientId: number;
	to: string;
	text: string;
	contactId: number;
	chatId: number | null;
	quotedId: number | null;
	fileId: number | null;
	readyMessageId: number | null;
	sendAsAudio: boolean;
	sendAsDocument: boolean;
	sendAsChatOwner: boolean;
	isForwarded: boolean;
	mentions: unknown[];
	file: { hash: string; name: string; type: string; size: number } | null;
}

function positiveId(value: unknown, name: string, optional = false): number | null {
	if (value === undefined || value === null || value === "") {
		if (optional) return null;
		throw new OperatorSendRequestError(`${name} é obrigatório.`);
	}
	if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value))) {
		throw new OperatorSendRequestError(`${name} deve ser um inteiro positivo.`);
	}
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id <= 0) throw new OperatorSendRequestError(`${name} inválido.`);
	return id;
}

function booleanField(value: unknown): boolean {
	if (value === undefined || value === null || value === "") return false;
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	throw new OperatorSendRequestError("Opção booleana inválida.");
}

export function resolveOperatorIdempotencyKey(header: unknown, body: unknown): string | null {
	if (header === undefined && body === undefined) return null;
	if (header !== undefined && body !== undefined && header !== body) {
		throw new OperatorSendRequestError("Chaves de envio divergentes no cabeçalho e no formulário.");
	}
	const key = header ?? body;
	if (typeof key !== "string" || !/^[A-Za-z0-9:_-]{8,128}$/.test(key)) {
		throw new OperatorSendRequestError("Chave de envio inválida.");
	}
	return key;
}

export function normalizeOperatorSendRequest(
	clientId: unknown,
	to: unknown,
	data: Record<string, unknown>,
	file?: Express.Multer.File,
): OperatorSendRequest {
	if (typeof to !== "string" || !to.trim() || to.length > 191) {
		throw new OperatorSendRequestError("Destinatário inválido.");
	}
	if (data["text"] != null && typeof data["text"] !== "string") {
		throw new OperatorSendRequestError("Texto da mensagem inválido.");
	}
	let mentions: unknown = data["mentions"] ?? [];
	if (typeof mentions === "string") {
		try { mentions = JSON.parse(mentions); } catch { throw new OperatorSendRequestError("Menções inválidas."); }
	}
	if (!Array.isArray(mentions) || mentions.length > 100) throw new OperatorSendRequestError("Menções inválidas.");
	const fileId = positiveId(data["fileId"], "fileId", true);
	if (file && fileId) throw new OperatorSendRequestError("Informe o arquivo ou fileId, não ambos.");
	const text = typeof data["text"] === "string" ? data["text"] : "";
	if (!text.trim() && !file && !fileId) throw new OperatorSendRequestError("Mensagem vazia.");
	return {
		clientId: positiveId(clientId, "clientId")!,
		to: to.trim(), text,
		contactId: positiveId(data["contactId"], "contactId")!,
		chatId: positiveId(data["chatId"], "chatId", true),
		quotedId: positiveId(data["quotedId"], "quotedId", true),
		fileId,
		readyMessageId: positiveId(data["readyMessageId"], "readyMessageId", true),
		sendAsAudio: booleanField(data["sendAsAudio"]),
		sendAsDocument: booleanField(data["sendAsDocument"]),
		sendAsChatOwner: booleanField(data["sendAsChatOwner"]),
		isForwarded: booleanField(data["isForwarded"]),
		mentions,
		file: file ? {
			hash: createHash("sha256").update(file.buffer).digest("hex"),
			name: file.originalname, type: file.mimetype, size: file.size,
		} : null,
	};
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

export function hashOperatorSendRequest(request: OperatorSendRequest): string {
	return createHash("sha256").update(JSON.stringify(canonical(request))).digest("hex");
}
