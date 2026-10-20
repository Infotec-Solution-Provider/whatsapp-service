import type { Customer, WppContactWithCustomer } from "../../sdk-local";
import type { ContactAudienceRequest } from "./contract";
import type { AudienceStore } from "./repository";

export type AudienceCustomerMatcher = (ids: number[], filters: Record<string, string>) => Promise<Customer[]>;
export interface AudienceSummary { total: number; eligible: number; blocked: number; skipped: number }
export class ContactAudienceReader {
	constructor(private readonly store: AudienceStore, private readonly matchCustomers: AudienceCustomerMatcher,
		private readonly clock: () => number = Date.now) {}

	async search(instance: string, request: ContactAudienceRequest) {
		const deadline = this.clock() + 55_000;
		const checkDeadline = () => { if (this.clock() >= deadline) throw new Error("Audience search deadline exceeded"); };
		// The authoritative customer parser must run even for an empty contact set.
		await this.matchCustomers([], request.customerFilters);
		checkDeadline();
		const pagination = request.pagination, isPage = "page" in pagination;
		const upperId = !isPage && pagination.upperId !== undefined ? pagination.upperId : await this.store.maxId(instance);
		let afterId = isPage ? 0 : pagination.afterId;
		const offset = isPage ? (pagination.page - 1) * pagination.perPage : 0;
		const limit = isPage ? pagination.perPage : pagination.limit;
		const hasCustomerFilters = Object.keys(request.customerFilters).length > 0;
		const summary: AudienceSummary = { total: 0, eligible: 0, blocked: 0, skipped: 0 };
		const data: WppContactWithCustomer[] = [];
		let hasNext = false;
		while (afterId < upperId) {
			checkDeadline();
			const candidates = await this.store.scan(instance, request.contactFilters, afterId, upperId);
			if (candidates.length > 100) throw new Error("Audience batch exceeds limit");
			if (!candidates.length) break;
			let previous = afterId;
			for (const candidate of candidates) {
				if (candidate.instance !== instance || candidate.isDeleted || !Number.isInteger(candidate.id) || candidate.id <= previous || candidate.id > upperId) {
					throw new Error("Invalid scoped audience batch");
				}
				previous = candidate.id;
			}
			const customerIds = [...new Set(candidates.flatMap(contact => contact.customerId === null ? [] : [contact.customerId]))];
			if (customerIds.some(id => !Number.isInteger(id) || id < -2147483648 || id > 2147483647)) throw new Error("Invalid CRM customer identity");
			const customers = customerIds.length ? await this.matchCustomers(customerIds, request.customerFilters) : [];
			checkDeadline();
			const customerMap = new Map<number, Customer>();
			for (const customer of customers) {
				if (!customerIds.includes(customer.CODIGO)) throw new Error("Unexpected CRM customer identity");
				customerMap.set(customer.CODIGO, customer);
			}
			for (const contact of candidates) {
				const customer = contact.customerId === null ? null : customerMap.get(contact.customerId) ?? null;
				if (hasCustomerFilters && customer === null) continue;
				const index = summary.total++;
				if (!contact.phone.replace(/\D/g, "")) summary.skipped++;
				else if (contact.isBlocked) summary.blocked++;
				else summary.eligible++;
				if (index >= offset && data.length < limit) data.push({ ...contact, customer });
				else if (!isPage && data.length === limit) { hasNext = true; break; }
			}
			if (hasNext) break;
			afterId = previous;
		}
		const sectorMap = await this.store.sectors(instance, data.map(contact => contact.id));
		checkDeadline();
		for (const contact of data) contact.sectorIds = sectorMap.get(contact.id) ?? [];
		if (!isPage) return { data, pagination: { hasNext, nextCursor: hasNext ? data[data.length - 1]!.id : null, upperId } };
		const totalPages = Math.ceil(summary.total / pagination.perPage);
		return { data, pagination: { page: pagination.page, perPage: pagination.perPage, total: summary.total,
			totalPages, hasNext: pagination.page < totalPages, hasPrev: pagination.page > 1 && totalPages > 0 }, summary };
	}
}
