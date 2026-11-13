import type { WppContact } from "@prisma/client";

export type CustomerResolution =
	| { status: "found"; customerId: number; reason?: "already_linked" | "linked" | "concurrent_link" | "sync_pending" }
	| { status: "not_found" | "ambiguous" | "unavailable"; reason?: string };

export interface CustomerResolutionScope { instance: string; sectorId: number }
export interface ContactCustomerResolutionResult { contact: WppContact; resolution: CustomerResolution }
export interface ContactCustomerResolutionDependencies {
	sectorBelongsToInstance(instance: string, sectorId: number): Promise<boolean>;
	getContact(instance: string, id: number): Promise<WppContact | null>;
	query(instance: string, sql: string, params: string[]): Promise<Array<{ customer_id: number | string }>>;
	linkIfUnchanged(contact: WppContact, customerId: number): Promise<number>;
	syncContact(contact: WppContact): Promise<void>;
}

/** Accept complete Brazilian addresses; never identify a customer by a suffix. */
export function customerResolutionPhone(phone: string | null): { ddd: string; local: string[]; full: string[] } | null {
	const digits = (phone ?? "").replace(/\D/g, "");
	const national = /^55\d{10,11}$/.test(digits) ? digits.slice(2) : digits;
	if (!/^[1-9]\d\d{8,9}$/.test(national)) return null;
	const ddd = national.slice(0, 2), body = national.slice(2);
	const local = [body];
	// The ninth digit is a mobile convention; do not change fixed-line identities.
	if (/^[6-9]\d{7}$/.test(body)) local.push(`9${body}`);
	if (/^9[6-9]\d{7}$/.test(body)) local.push(body.slice(1));
	return { ddd, local: [...new Set(local)], full: [...new Set(local.flatMap(value => [`${ddd}${value}`, `55${ddd}${value}`]))] };
}

function normalizedSql(column: string): string {
	// Every identifier is supplied below by static, schema-verified constants.
	return [" ", "(", ")", "-", "+", "."].reduce((sql, character) => `REPLACE(${sql}, '${character}', '')`, `TRIM(COALESCE(${column}, ''))`);
}

/** A single statement succeeds for both sources or returns no classification. MySQL 5.5 compatible. */
export function buildContactCustomerResolutionQuery(phone: string | null): { sql: string; params: string[] } | null {
	const numbers = customerResolutionPhone(phone);
	if (!numbers) return null;
	const params: string[] = [];
	const pair = (area: string, value: string): string => {
		params.push(...numbers.full, numbers.ddd, ...numbers.local);
		return `(${normalizedSql(value)} IN (${numbers.full.map(() => "?").join(",")}) OR (${normalizedSql(area)} = ? AND ${normalizedSql(value)} IN (${numbers.local.map(() => "?").join(",")})))`;
	};
	const customers = [1, 2, 3].map(index => pair(`c.AREA${index}`, `c.FONE${index}`));
	const contacts = [["AREA_CEL", "CELULAR"], ["AREA_DIRETO", "FONE_DIRETO"], ["AREA_RESI", "FONE_RESIDENCIAL"]].map(([area, value]) => pair(`ct.${area}`, `ct.${value}`));
	return {
		sql: `SELECT DISTINCT candidate.customer_id FROM (SELECT c.CODIGO AS customer_id FROM clientes c WHERE c.CODIGO > 0 AND (${customers.join(" OR ")}) UNION ALL SELECT ct.CLIENTE AS customer_id FROM contatos ct INNER JOIN clientes owner ON owner.CODIGO=ct.CLIENTE WHERE ct.CLIENTE > 0 AND (${contacts.join(" OR ")})) candidate ORDER BY candidate.customer_id LIMIT 2`,
		params
	};
}

const positive = (value: number | null): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const emptyLink = (value: number | null): boolean => value === null || value === 0 || value === -1;
const sameAddress = (before: WppContact, after: WppContact): boolean => before.phone === after.phone && before.whatsappId === after.whatsappId;

/** Resolves identity only. Recipients and fallback decisions belong to the configured flow. */
export class ContactCustomerResolutionService {
	constructor(private readonly dependencies: ContactCustomerResolutionDependencies) {}

	async resolve(scope: CustomerResolutionScope, supplied: WppContact): Promise<ContactCustomerResolutionResult> {
		if (!scope.instance || supplied.instance !== scope.instance || !Number.isSafeInteger(scope.sectorId) || scope.sectorId <= 0 || !Number.isSafeInteger(supplied.id) || supplied.id <= 0) {
			throw new Error("CUSTOMER_RESOLUTION_SCOPE_MISMATCH");
		}
		let contact = supplied;
		const result = (resolution: CustomerResolution): ContactCustomerResolutionResult => ({ contact, resolution });
		const reread = async (): Promise<WppContact | null> => {
			const row = await this.dependencies.getContact(scope.instance, supplied.id);
			return row && row.id === supplied.id && row.instance === scope.instance && !row.isDeleted ? row : null;
		};
		try {
			if (!await this.dependencies.sectorBelongsToInstance(scope.instance, scope.sectorId)) throw new Error("CUSTOMER_RESOLUTION_SCOPE_MISMATCH");
		} catch (error) {
			if (error instanceof Error && error.message === "CUSTOMER_RESOLUTION_SCOPE_MISMATCH") throw error;
			return result({ status: "unavailable", reason: "scope_unavailable" });
		}
		try {
			const current = await reread();
			if (!current) return result({ status: "unavailable", reason: "contact_unavailable" });
			contact = current;
			if (positive(contact.customerId)) return result({ status: "found", customerId: contact.customerId, reason: "already_linked" });
			if (!emptyLink(contact.customerId)) return result({ status: "unavailable", reason: "reserved_customer_link" });
			const query = buildContactCustomerResolutionQuery(contact.phone);
			if (!query) return result({ status: "unavailable", reason: "invalid_phone" });
			const rows = await this.dependencies.query(scope.instance, query.sql, query.params);
			if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(Number(row.customer_id)) || Number(row.customer_id) <= 0)) return result({ status: "unavailable", reason: "invalid_lookup_result" });
			const ids = [...new Set(rows.map(row => Number(row.customer_id)))];
			// Even zero/ambiguous results must respect a manual link or address change made during the query.
			const latest = await reread();
			if (!latest) return result({ status: "unavailable", reason: "contact_unavailable" });
			if (positive(latest.customerId)) { contact = latest; return result({ status: "found", customerId: latest.customerId, reason: "concurrent_link" }); }
			if (!sameAddress(contact, latest) || latest.customerId !== contact.customerId) { contact = latest; return result({ status: "unavailable", reason: "contact_changed" }); }
			contact = latest;
			if (ids.length === 0) return result({ status: "not_found" });
			if (ids.length > 1) return result({ status: "ambiguous" });
			const customerId = ids[0]!;
			const count = await this.dependencies.linkIfUnchanged(contact, customerId);
			const saved = await reread();
			if (!saved) return result({ status: "unavailable", reason: "contact_unavailable" });
			contact = saved;
			if (!positive(saved.customerId)) return result({ status: "unavailable", reason: "contact_changed" });
			if (count !== 1 || saved.customerId !== customerId) return result({ status: "found", customerId: saved.customerId, reason: "concurrent_link" });
			try { await this.dependencies.syncContact(saved); }
			catch { return result({ status: "found", customerId, reason: "sync_pending" }); }
			return result({ status: "found", customerId, reason: "linked" });
		} catch {
			// A partial/unavailable CRM or failed CAS is never evidence of a new customer.
			try {
				const current = await reread();
				if (current) {
					contact = current;
					if (positive(current.customerId)) return result({ status: "found", customerId: current.customerId, reason: "concurrent_link" });
				}
			} catch { /* Keep the last successfully read contact, without inventing a link. */ }
			return result({ status: "unavailable", reason: "lookup_unavailable" });
		}
	}
}
