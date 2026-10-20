import { BadRequestError } from "@rgranatodutra/http-errors";

export interface ContactAudienceFilters {
	id?: number;
	ids?: number[];
	name?: string;
	phone?: string;
	hasCustomer?: boolean;
	sectorIds?: number[];
}
export type AudiencePagination = { page: number; perPage: number } |
	{ afterId: number; limit: number; upperId?: number };
export interface ContactAudienceRequest {
	contactFilters: ContactAudienceFilters;
	customerFilters: Record<string, string>;
	pagination: AudiencePagination;
}

// Field validation remains authoritative in customers-service. These are only
// filter keys: pagination, sorting and tenant identity cannot cross this boundary.
const customerKeys = new Set([
	"CODIGO", "RAZAO", "FANTASIA", "COD_ERP", "CPF_CNPJ", "CIDADE", "ESTADO", "ATIVO", "PESSOA",
	"phone", "email", "purchaseStatus", "purchaseFrom", "purchaseTo", "registeredFrom", "registeredTo",
	"campaignIds", "segmentIds", "groupIds", "originIds", "mediaIds", "unitIds", "brandIds", "positionIds",
	"loyaltyOperatorIds", "states"
]);
const invalid = (message = "Filtros de público inválidos."): never => { throw new BadRequestError(message); };
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) invalid("Filtro de público não permitido.");
}
function integer(value: unknown, minimum: number, maximum = 2147483647): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
	return value;
}
function idList(value: unknown, minimum: number): number[] {
	if (!Array.isArray(value) || value.length > 100) return invalid("Selecione no máximo 100 códigos por lote.");
	return [...new Set(value.map(id => integer(id, minimum)))];
}

export function parseContactAudienceRequest(input: unknown): ContactAudienceRequest {
	const body = record(input);
	keys(body, ["contactFilters", "customerFilters", "pagination"]);
	const rawContact = record(body["contactFilters"]), rawCustomer = record(body["customerFilters"]);
	keys(rawContact, ["id", "ids", "name", "phone", "hasCustomer", "sectorIds"]);
	const contactFilters: ContactAudienceFilters = {};
	if ("id" in rawContact) contactFilters.id = integer(rawContact["id"], 1);
	if ("ids" in rawContact) contactFilters.ids = idList(rawContact["ids"], 1);
	if ("sectorIds" in rawContact) contactFilters.sectorIds = idList(rawContact["sectorIds"], -2147483648);
	for (const key of ["name", "phone"] as const) if (key in rawContact) {
		const value = rawContact[key];
		if (typeof value !== "string" || value.length > (key === "phone" ? 40 : 255)) return invalid();
		if (value.trim()) contactFilters[key] = value.trim();
	}
	if (contactFilters.phone && (!/^\+?[\d ().-]+$/.test(contactFilters.phone) || !contactFilters.phone.replace(/\D/g, ""))) {
		return invalid("Telefone de contato inválido.");
	}
	if ("hasCustomer" in rawContact) {
		if (typeof rawContact["hasCustomer"] !== "boolean") return invalid();
		contactFilters.hasCustomer = rawContact["hasCustomer"];
	}
	const customerFilters: Record<string, string> = {};
	for (const [key, value] of Object.entries(rawCustomer)) {
		if (!customerKeys.has(key) || typeof value !== "string" || value.length > 1500) return invalid("Filtro de cliente não permitido.");
		if (value.trim()) customerFilters[key] = value.trim();
	}
	const rawPagination = record(body["pagination"]);
	let pagination: AudiencePagination;
	if ("page" in rawPagination) {
		keys(rawPagination, ["page", "perPage"]);
		const page = integer(rawPagination["page"], 1, Number.MAX_SAFE_INTEGER);
		const perPage = integer(rawPagination["perPage"], 1, 100);
		if (!Number.isSafeInteger((page - 1) * perPage)) return invalid("Paginação inválida.");
		pagination = { page, perPage };
	} else {
		keys(rawPagination, ["afterId", "limit", "upperId"]);
		const afterId = integer(rawPagination["afterId"], 0), limit = integer(rawPagination["limit"], 1, 200);
		pagination = { afterId, limit };
		if ("upperId" in rawPagination) {
			pagination.upperId = integer(rawPagination["upperId"], 0);
			if (afterId > pagination.upperId) return invalid("Cursor de público inválido.");
		}
	}
	return { contactFilters, customerFilters, pagination };
}
