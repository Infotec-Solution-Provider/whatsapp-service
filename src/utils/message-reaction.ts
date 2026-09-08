export class MessageReactionError extends Error {
	constructor(message: string, public readonly statusCode = 400, public readonly code = "INVALID_REACTION") { super(message); }
}

export function reactionEmoji(value: unknown): string {
	if (typeof value !== "string" || value.length > 64) throw new MessageReactionError("Informe um emoji ou texto vazio para remover a reação.");
	if (value === "") return value;
	const Segmenter = (Intl as unknown as { Segmenter: new (locale: string, options: { granularity: string }) => { segment(value: string): Iterable<unknown> } }).Segmenter;
	if ([...new Segmenter("pt", { granularity: "grapheme" }).segment(value)].length !== 1 ||
		!/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(value) ||
		/[\s\u0000-\u001f]/u.test(value)) throw new MessageReactionError("A reação deve conter um único emoji.");
	return value;
}

/** WWEBJS serializes a WA key; other provider IDs stay opaque. */
export function canonicalReactionTarget(value: string): string {
	return /^(?:true|false)_[^_]+_([^_]+)(?:_.*)?$/.exec(value)?.[1] ?? value;
}

export function reactionActor(actor: unknown, fromMe: boolean): string {
	if (fromMe) return "self";
	if (typeof actor !== "string" || !actor.trim()) return "legacy:unknown";
	return actor.trim().replace(/:\d+(?=@)/, "").replace(/@c\.us$/, "@s.whatsapp.net");
}

export function reactionTimestamp(value: unknown, fallback = new Date()): Date {
	const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
	const date = Number.isFinite(number) ? new Date(number < 100_000_000_000 ? number * 1000 : number) : fallback;
	return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : fallback;
}

export function positiveReactionId(value: unknown): number {
	if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) throw new MessageReactionError("Identificador inválido.");
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id <= 0) throw new MessageReactionError("Identificador inválido.");
	return id;
}
