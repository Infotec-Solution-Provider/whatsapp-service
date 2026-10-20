import type { WppContactWithCustomer } from "../../sdk-local";
import type { ContactAudienceFilters } from "./contract";

export type AudienceContact = Omit<WppContactWithCustomer, "customer">;
export type AudienceExecute = <T>(sql: string, parameters: unknown[]) => Promise<T>;
export interface AudienceStore {
	maxId(instance: string): Promise<number>;
	scan(instance: string, filters: ContactAudienceFilters, afterId: number, upperId: number): Promise<AudienceContact[]>;
	sectors(instance: string, ids: number[]): Promise<Map<number, number[]>>;
}
type Row = Record<string, unknown>;
const t = { contacts: "contacts", sectors: "contacts_sectors", contactKey: "contactId", sectorKey: "sectorId" };
function like(value: string) { return `%${value.replace(/[!%_]/g, part => "!" + part)}%`; }
export function audienceScanQuery(instance: string, filters: ContactAudienceFilters, afterId: number, upperId: number) {
	const conditions = ["ctt.instance = ?", "ctt.is_deleted = false", "ctt.id > ?", "ctt.id <= ?"];
	const values: unknown[] = [instance, afterId, upperId];
	if (filters.id !== undefined) { conditions.push("ctt.id = ?"); values.push(filters.id); }
	if (filters.ids !== undefined) {
		if (!filters.ids.length) conditions.push("1 = 0");
		else { conditions.push(`ctt.id IN (${filters.ids.map(() => "?").join(",")})`); values.push(...filters.ids); }
	}
	if (filters.name) { conditions.push("ctt.name LIKE ? ESCAPE '!'"); values.push(like(filters.name)); }
	if (filters.phone) { conditions.push("ctt.phone LIKE ? ESCAPE '!'"); values.push(like(filters.phone.replace(/\D/g, ""))); }
	if (filters.hasCustomer !== undefined) conditions.push(`ctt.customer_id IS ${filters.hasCustomer ? "NOT " : ""}NULL`);
	if (filters.sectorIds?.length) {
		conditions.push(`EXISTS (SELECT 1 FROM ${t.sectors} sector WHERE sector.${t.contactKey} = ctt.id AND sector.${t.sectorKey} IN (${filters.sectorIds.map(() => "?").join(",")}))`);
		values.push(...filters.sectorIds);
	}
	return { sql: `SELECT ctt.* FROM ${t.contacts} ctt WHERE ${conditions.join(" AND ")} ORDER BY ctt.id ASC LIMIT 100`, values };
}
function date(value: unknown): Date | null {
	if (value == null) return null;
	const parsed = value instanceof Date ? value : new Date(String(value));
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}
export class ContactAudienceRepository implements AudienceStore {
	constructor(private readonly execute: AudienceExecute) {}
	async maxId(instance: string): Promise<number> {
		const rows = await this.execute<Row[]>(`SELECT MAX(id) AS upper_id FROM ${t.contacts} WHERE instance = ? AND is_deleted = false`, [instance]);
		const id = Number(rows[0]?.["upper_id"] ?? 0);
		if (!Number.isInteger(id) || id < 0 || id > 2147483647) throw new Error("Invalid audience upper bound");
		return id;
	}
	async scan(instance: string, filters: ContactAudienceFilters, afterId: number, upperId: number): Promise<AudienceContact[]> {
		const query = audienceScanQuery(instance, filters, afterId, upperId);
		const rows = await this.execute<Row[]>(query.sql, query.values);
		return rows.map(row => ({
			id: Number(row["id"]), instance: String(row["instance"]),
			name: String(row["name"] ?? ""),
			phone: String(row["phone"] ?? ""), customerId: row["customer_id"] == null ? null : Number(row["customer_id"]),
			avatarUrl: row["avatar_url"] == null ? null : String(row["avatar_url"]),
			isDeleted: Number(row["is_deleted"]) === 1, isBlocked: Number(row["is_blocked"]) === 1, isOnlyAdmin: Number(row["is_only_admin"]) === 1,
			createdAt: date(row["created_at"]) ?? new Date(0), updatedAt: date(row["updated_at"]),
			conversationExpiration: row["conversation_expiration"] == null ? null : String(row["conversation_expiration"]),
			lastOutOfHoursReplySentAt: date(row["last_out_of_hours_reply_sent_at"]), chatingWith: null, sectorIds: []
		}));
	}
	async sectors(instance: string, ids: number[]): Promise<Map<number, number[]>> {
		const result = new Map<number, number[]>();
		for (let offset = 0; offset < ids.length; offset += 100) {
			const chunk = ids.slice(offset, offset + 100);
			const rows = await this.execute<Row[]>(`SELECT sector.${t.contactKey} AS contact_id, sector.${t.sectorKey} AS sector_id FROM ${t.sectors} sector JOIN ${t.contacts} ctt ON ctt.id = sector.${t.contactKey} WHERE ctt.instance = ? AND ctt.id IN (${chunk.map(() => "?").join(",")})`, [instance, ...chunk]);
			for (const row of rows) {
				const id = Number(row["contact_id"]), sector = Number(row["sector_id"]);
				const previous = result.get(id) ?? [];
				if (!previous.includes(sector)) previous.push(sector);
				result.set(id, previous);
			}
		}
		return result;
	}
}
