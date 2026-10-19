import type { LinkCustomer } from "./contact-customer-link.service";

export const CONTACT_PHONE_SUGGESTIONS_PARAMETER = "contact_customer_phone_suggestions_enabled";
export const CUSTOMER_PHONE_COLUMNS = ["CODIGO", "FONE1", "FONE2", "FONE3", "AREA1", "AREA2", "AREA3"] as const;
const MAX_SUGGESTIONS = 10;

export interface CustomerPhoneSuggestions {
	status: "ready" | "disabled" | "unsupported" | "unavailable";
	candidates: LinkCustomer[];
	truncated: boolean;
}

/** Exact Brazilian numbers only; never guess the ninth digit or match a phone suffix. */
export function phoneLookupAlternatives(phone: string | null): string[] {
	const digits = (phone || "").replace(/\D/g, "");
	const national = /^55\d{10,11}$/.test(digits) ? digits.slice(2) : digits;
	if (!/^\d{10,11}$/.test(national)) return [];
	return [national, `55${national}`];
}

function digitsSql(column: string): string {
	// column comes exclusively from the static allowlist below.
	return [" ", "(", ")", "-", "+", "."].reduce(
		(sql, character) => `REPLACE(${sql}, '${character}', '')`,
		`TRIM(COALESCE(\`${column}\`, ''))`
	);
}

export function buildCustomerPhoneLookup(columns: string[], phone: string | null) {
	const available = new Set(columns);
	const phones = phoneLookupAlternatives(phone);
	if (!available.has("CODIGO") || phones.length === 0) return null;
	const conditions: string[] = [];
	const params: string[] = [];
	for (const suffix of ["1", "2", "3"]) {
		const phoneColumn = `FONE${suffix}`;
		if (!available.has(phoneColumn)) continue;
		const normalized = digitsSql(phoneColumn);
		conditions.push(`${normalized} IN (?, ?)`);
		params.push(...phones);
		if (available.has(`AREA${suffix}`)) {
			conditions.push(`CONCAT(${digitsSql(`AREA${suffix}`)}, ${normalized}) IN (?, ?)`);
			params.push(...phones);
		}
	}
	if (!conditions.length) return null;
	return {
		sql: `SELECT DISTINCT CODIGO AS id FROM clientes WHERE (${conditions.join(" OR ")}) ORDER BY CODIGO LIMIT ${MAX_SUGGESTIONS + 1}`,
		params
	};
}

export interface CustomerPhoneLookupDependencies {
	columns(): Promise<string[]>;
	query(sql: string, params: string[]): Promise<Array<{ id: number }>>;
	getCustomer(id: number): Promise<LinkCustomer | null>;
}

export async function suggestCustomersByPhone(
	enabled: boolean,
	phone: string | null,
	dependencies: CustomerPhoneLookupDependencies
): Promise<CustomerPhoneSuggestions> {
	const empty = (status: CustomerPhoneSuggestions["status"]): CustomerPhoneSuggestions => ({ status, candidates: [], truncated: false });
	if (!enabled) return empty("disabled");
	if (!phoneLookupAlternatives(phone).length) return empty("unsupported");
	try {
		const query = buildCustomerPhoneLookup(await dependencies.columns(), phone);
		if (!query) return empty("unsupported");
		const rows = await dependencies.query(query.sql, query.params);
		const ids = [...new Set(rows.map((row) => Number(row.id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
		const candidates: LinkCustomer[] = [];
		// Keep the user's ordinary customer API authorization; at most 3 lookups concurrently.
		const selected = ids.slice(0, MAX_SUGGESTIONS);
		for (let start = 0; start < selected.length; start += 3) {
			const batch = selected.slice(start, start + 3);
			const customers = await Promise.all(batch.map((id) => dependencies.getCustomer(id)));
			for (let index = 0; index < customers.length; index++) {
				const customer = customers[index];
				if (customer && customer.id === batch[index]) candidates.push(customer);
			}
		}
		return { status: "ready", candidates, truncated: ids.length > MAX_SUGGESTIONS };
	} catch {
		// An unavailable CRM is not a valid zero-result lookup.
		return empty("unavailable");
	}
}
