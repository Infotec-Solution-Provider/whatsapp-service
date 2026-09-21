import { createHash } from "node:crypto";
import { additions, manifestHash } from "./prepare-contract";
import { legacyContract } from "./legacy-contract";
import { decodeTenantText, encodeTenantText } from "./encoding";

export type DataRow = Record<string, string | number | null>;
export class TenantDataError extends Error {
	constructor(readonly diagnosticCode: string, readonly context: Record<string, unknown> = {}) { super(diagnosticCode); }
}
export const entities = ["contacts", "chats", "messages", "schedules", "contacts_sectors"] as const;
export type Entity = typeof entities[number];
export const tables: Record<Entity, keyof typeof legacyContract> = {
	contacts: "wpp_contacts", chats: "wpp_chats", messages: "wpp_messages", schedules: "wpp_schedules", contacts_sectors: "wpp_contact_sectors",
};
export const keys = (entity: Entity) => entity === "contacts_sectors" ? ["contact_id", "sector_id"] : ["id"];
export const fields = (entity: Entity) => [...legacyContract[tables[entity]].columns.map(c => c.name), ...Object.keys(additions[tables[entity]] ?? {})];
export const epochSources: Record<string, string> = {
	created_at_epoch_ms: "created_at", updated_at_epoch_ms: "updated_at", last_out_of_hours_reply_sent_at_epoch_ms: "last_out_of_hours_reply_sent_at",
	started_at_epoch_ms: "started_at", finished_at_epoch_ms: "finished_at", sent_at_epoch_ms: "sent_at",
	scheduled_at_epoch_ms: "scheduled_at", schedule_date_epoch_ms: "schedule_date",
};
const encoded: Record<string, string[]> = {
	contacts: ["name", "avatar_url"], chats: ["avatar_url", "avatar_url_encoded"],
	messages: ["body", "file_name", "mention_metadata"], schedules: ["description"], contacts_sectors: [],
};
export const dateFields = new Set(["started_at", "finished_at", "sent_at", "scheduled_at", "schedule_date"]);
export function sourceColumn(entity: Entity, field: string): string {
	if (entity === "contacts_sectors") return field === "contact_id" ? "contactId" : "sectorId";
	return epochSources[field] ?? (field === "original_id" ? "id" : field === "avatar_url_encoded" ? "avatar_url" : field);
}
export function epoch(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,3})?$/.test(value)) throw new TenantDataError("TENANT_SOURCE_DATE_INVALID");
	const text = value.replace(" ", "T"), expected = text.includes(".") ? text.padEnd(23, "0") : `${text}.000`;
	const ms = Date.parse(`${text}Z`);
	if (!Number.isFinite(ms) || new Date(ms).toISOString() !== `${expected}Z`) throw new TenantDataError("TENANT_SOURCE_DATE_INVALID");
	return ms;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
export function legacyDate(value: unknown, timezone: string): string | null {
	const ms = epoch(value); if (ms === null) return null;
	let formatter = formatters.get(timezone);
	if (!formatter) { formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); formatters.set(timezone, formatter); }
	const parts = Object.fromEntries(formatter.formatToParts(ms).map(p => [p.type, p.value]));
	return `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]}:${parts["second"]}`;
}
function canonicalJson(text: string): string {
	// Sort object keys without rounding JSON numbers through JavaScript's Number type.
	const original = JSON.stringify(JSON.parse(text));
	let prefix = "@migration-number:";
	while (original.includes(prefix)) prefix += "@";
	const tokens = text.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => token.startsWith('"') ? token : JSON.stringify(prefix + token));
	const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
	return JSON.stringify(sort(JSON.parse(tokens)));
}
export function mapRow(entity: Entity, source: DataRow, timezone: string): DataRow {
	const mapped: DataRow = {};
	for (const field of fields(entity)) {
		let value = source[field];
		if (value === undefined) throw new TenantDataError("TENANT_SOURCE_COLUMN_MISSING", { entity, column: field });
		if (epochSources[field]) value = epoch(value)?.toString() ?? null;
		else if (dateFields.has(field)) value = legacyDate(value, timezone);
		else if (field === "mention_metadata" && value !== null) {
			try { JSON.parse(String(value)); value = String(value); } catch { throw new TenantDataError("TENANT_SOURCE_JSON_INVALID", { entity, id: source["id"] }); }
		}
		if (encoded[entity]!.includes(field)) {
			try { value = encodeTenantText(value === null ? null : String(value), "percent-encoded-v1"); }
			catch { throw new TenantDataError("TENANT_SOURCE_TEXT_INVALID", { entity, id: source["id"], column: field }); }
		}
		mapped[field] = value;
	}
	return mapped;
}
export function compareRow(entity: Entity, expected: DataRow, actual: DataRow, allowEnrichment: boolean) {
	const conflicts: string[] = [], enrich: string[] = [];
	for (const field of fields(entity)) {
		const wanted = expected[field], got = actual[field];
		if (allowEnrichment && Object.hasOwn(additions[tables[entity]] ?? {}, field) && got === null && wanted !== null) { enrich.push(field); continue; }
		if (wanted === null || got === null || got === undefined) { if (wanted !== got) conflicts.push(field); continue; }
		let equal = String(wanted) === String(got);
		if (encoded[entity]!.includes(field)) {
			try {
				const decoded = decodeTenantText(String(got), "percent-encoded-v1");
				equal = field === "mention_metadata"
					? canonicalJson(decoded!) === canonicalJson(decodeTenantText(String(wanted), "percent-encoded-v1")!)
					: decoded === decodeTenantText(String(wanted), "percent-encoded-v1");
			} catch { equal = false; }
			// Two documented legacy writers used different avatar representations.
			if (entity === "chats" && field === "avatar_url") equal ||= String(got) === decodeTenantText(String(wanted), "percent-encoded-v1");
		}
		if (!equal) conflicts.push(field);
	}
	return { conflicts, enrich };
}
export const dataContractHash = createHash("sha256").update(JSON.stringify({ version: "core-copy-v1", json: "lossless-numeric-token-v1", manifestHash, tables, epochSources, encoded })).digest("hex");
