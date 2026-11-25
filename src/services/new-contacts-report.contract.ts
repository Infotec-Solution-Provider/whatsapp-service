import { BadRequestError } from "@rgranatodutra/http-errors";

export const NEW_CONTACTS_PILOT_INSTANCE = "suprimaxxi";
const DAY_MS = 86_400_000;
const DATABASE_MAX_ID = 2_147_483_647;
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Sao_Paulo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit"
});

export type NewContactsStatus = "open" | "finished" | "no_chat";
export type FirstReplyStatus = "identified" | "unidentified" | "none";
type IdFilter = "firstChannelIds" | "sectorIds" | "ownerIds" | "firstResponderIds";
const idFilters = ["firstChannelIds", "sectorIds", "ownerIds", "firstResponderIds"] as const;

export interface NewContactsQuery {
	from: Date;
	toExclusive: Date;
	ids: Record<IdFilter, number[]>;
	ownership?: "assigned" | "unassigned";
	status?: NewContactsStatus;
	linked?: boolean;
	direction: "asc" | "desc";
	page: number;
	pageSize: number;
	offset: number;
	limit: number;
}

export function canReadNewContactsReport(session: { instance: string; role: string }): boolean {
	return session.instance.toLowerCase() === NEW_CONTACTS_PILOT_INSTANCE && session.role.toUpperCase() === "ADMIN";
}

function invalid(message: string): never {
	throw new BadRequestError(message);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return invalid("Informe os filtros do relatório de novos contatos.");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some(key => !keys.includes(key)))
		return invalid("O relatório de novos contatos recebeu um campo não permitido.");
	return input;
}

function day(value: unknown): number {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1000-01-01" || value > "9998-12-31")
		return invalid("Informe as datas no formato AAAA-MM-DD.");
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value)
		return invalid("Informe datas válidas.");
	return timestamp;
}

// Locate the first instant of the civil day, including past daylight-saving transitions at midnight.
function startOfSaoPauloDay(utcMidnight: number): Date {
	const day = dateFormatter.format(new Date(utcMidnight + DAY_MS / 2));
	let lower = utcMidnight - DAY_MS;
	let upper = utcMidnight + DAY_MS;
	while (lower < upper) {
		const middle = Math.floor((lower + upper) / 2);
		if (dateFormatter.format(new Date(middle)) < day) lower = middle + 1;
		else upper = middle;
	}
	return new Date(lower);
}

function positiveInteger(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function idList(value: unknown): number[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 100 || value.some(id => !positiveInteger(id, DATABASE_MAX_ID)))
		return invalid("Selecione até 100 códigos válidos por filtro.");
	return [...new Set(value as number[])];
}

export function parseNewContactsQuery(body: unknown): NewContactsQuery {
	const request = record(body, ["filters", "page", "pageSize", "sort", "exportLimit"]);
	const filters = record(request["filters"], ["from", "to", "linked", "status", "ownership", ...idFilters]);
	const from = day(filters["from"]);
	const to = day(filters["to"]) + DAY_MS;
	if (to <= from || to - from > 90 * DAY_MS)
		return invalid("Selecione um período de até 90 dias com a data inicial anterior ou igual à final.");

	const linked = filters["linked"];
	if (linked !== undefined && typeof linked !== "boolean") return invalid("Vínculo inválido.");
	const status = filters["status"];
	if (status !== undefined && status !== "open" && status !== "finished" && status !== "no_chat")
		return invalid("Situação da conversa inválida.");
	const ownership = filters["ownership"];
	if (ownership !== undefined && ownership !== "assigned" && ownership !== "unassigned")
		return invalid("Situação do responsável inválida.");
	const page = request["page"] ?? 1;
	const pageSize = request["pageSize"] ?? 25;
	const exportLimit = request["exportLimit"];
	if (!positiveInteger(page, 100_000) || !positiveInteger(pageSize, 100) ||
		(exportLimit !== undefined && !positiveInteger(exportLimit, 10_000)))
		return invalid("Paginação ou limite de exportação inválido.");
	const sort = request["sort"] === undefined ? { field: "firstInboundAt", direction: "desc" } :
		record(request["sort"], ["field", "direction"]);
	const direction = sort["direction"];
	if (sort["field"] !== "firstInboundAt" || (direction !== "asc" && direction !== "desc"))
		return invalid("Ordenação inválida.");

	return {
		from: startOfSaoPauloDay(from),
		toExclusive: startOfSaoPauloDay(to),
		direction,
		ids: {
			firstChannelIds: idList(filters["firstChannelIds"]),
			sectorIds: idList(filters["sectorIds"]),
			ownerIds: idList(filters["ownerIds"]),
			firstResponderIds: idList(filters["firstResponderIds"])
		},
		...(ownership !== undefined && { ownership }),
		...(status !== undefined && { status }),
		...(linked !== undefined && { linked }),
		page: exportLimit === undefined ? page : 1,
		pageSize: exportLimit ?? pageSize,
		offset: exportLimit === undefined ? (page - 1) * pageSize : 0,
		limit: exportLimit === undefined ? pageSize : exportLimit + 1
	};
}
