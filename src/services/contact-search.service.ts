import { Customer, CustomersClient, UsersClient } from "../sdk-local";
import { Logger } from "@in.pulse-crm/utils";
import { Prisma } from "@prisma/client";
import chatsService from "./chats.service";
import getCustomersClient from "./customers.service";
import prismaService from "./prisma.service";
import getUsersClient from "./users.service";

// ============================================================================
// Types
// ============================================================================

export interface ContactSearchFilters {
	ids?: number[] | null;
	id?: number | null;
	name?: string | null;
	phone?: string | null;
	customerIds?: number[] | null;
	customerId?: number | null;
	customerErp?: string | null;
	customerCnpj?: string | null;
	customerName?: string | null;
	hasCustomer?: boolean | null;
	sectorIds?: number[] | null;
	purchaseStatus?: "with_purchases" | "without_purchases" | null;
	purchaseFrom?: string | null;
	purchaseTo?: string | null;
	campaignIds?: number[] | null;
	segmentIds?: number[] | null;
	registeredFrom?: string | null;
	registeredTo?: string | null;
	loyaltyOperatorIds?: number[] | null;
}

export interface PaginationParams {
	page: number;
	perPage: number;
}

export interface PaginatedResult<T> {
	data: T[];
	pagination: {
		page: number;
		perPage: number;
		total: number;
		totalPages: number;
		hasNext: boolean;
		hasPrev: boolean;
	};
}

export interface EnrichedContact {
	id: number;
	instance: string;
	name: string;
	phone: string;
	customerId: number | null;
	isDeleted: boolean;
	sectors?: { sectorId: number }[];
	customer: Customer | null;
	chatingWith: string | null;
}

// ============================================================================
// Query Builder - Constrói condições Prisma de forma composável
// ============================================================================

class ContactQueryBuilder {
	private conditions: Prisma.WppContactWhereInput[] = [];

	constructor(instance: string) {
		// Condições base sempre aplicadas
		this.conditions.push({ instance, isDeleted: false });
	}

	withId(id: number | null | undefined): this {
		if (typeof id === "number" && Number.isFinite(id)) {
			this.conditions.push({ id });
		}
		return this;
	}

	withIds(ids: number[] | null | undefined): this {
		if (ids && ids.length > 0) {
			this.conditions.push({ id: { in: ids } });
		}
		return this;
	}

	withName(name: string | null | undefined): this {
		const trimmed = name?.trim();
		if (trimmed) {
			this.conditions.push({ name: { contains: trimmed } });
		}
		return this;
	}

	withPhone(phone: string | null | undefined): this {
		const digits = phone?.replace(/\D/g, "");
		if (digits) {
			this.conditions.push({ phone: { contains: digits } });
		}
		return this;
	}

	withCustomerId(customerId: number | null | undefined): this {
		if (typeof customerId === "number" && Number.isFinite(customerId)) {
			this.conditions.push({ customerId });
		}
		return this;
	}

	withCustomerIds(customerIds: number[]): this {
		if (customerIds.length > 0) {
			this.conditions.push({ customerId: { in: customerIds } });
		}
		return this;
	}

	withHasCustomer(hasCustomer: boolean | null | undefined): this {
		if (hasCustomer === true) {
			this.conditions.push({ customerId: { not: null } });
		} else if (hasCustomer === false) {
			this.conditions.push({ customerId: null });
		}
		return this;
	}

	withSectors(sectorIds: number[] | null | undefined): this {
		if (sectorIds && sectorIds.length > 0) {
			this.conditions.push({
				sectors: { some: { sectorId: { in: sectorIds } } }
			} as Prisma.WppContactWhereInput);
		}
		return this;
	}

	build(): Prisma.WppContactWhereInput {
		if (this.conditions.length === 1) {
			return this.conditions[0]!;
		}
		return { AND: this.conditions };
	}
}

// ============================================================================
// Customer Search - Busca IDs de clientes por filtros externos
// ============================================================================

class CustomerSearcher {
	private instance: string;

	constructor(instance: string, private customersService: CustomersClient) {
		this.instance = instance;
	}

	async searchByFilters(filters: ContactSearchFilters): Promise<number[] | null> {
		const hasFilters = !!(
			filters.customerErp ||
			filters.customerCnpj ||
			filters.customerName ||
			filters.purchaseStatus ||
			filters.purchaseFrom ||
			filters.purchaseTo ||
			filters.campaignIds?.length ||
			filters.segmentIds?.length ||
			filters.registeredFrom ||
			filters.registeredTo ||
			filters.loyaltyOperatorIds?.length
		);
		if (!hasFilters) {
			return null; // Null significa "sem filtro de cliente"
		}

		const ids = new Set<number>();

		const perPage = 100;
		const requestFilters: Record<string, string> = {
			perPage: String(perPage),
			...(filters.customerErp?.trim() ? { COD_ERP: filters.customerErp.trim() } : {}),
			...(filters.customerCnpj?.trim() ? { CPF_CNPJ: filters.customerCnpj.replace(/\D/g, "") } : {}),
			...(filters.customerName?.trim() ? { RAZAO: filters.customerName.trim() } : {}),
			...(filters.purchaseStatus ? { purchaseStatus: filters.purchaseStatus } : {}),
			...(filters.purchaseFrom ? { purchaseFrom: filters.purchaseFrom } : {}),
			...(filters.purchaseTo ? { purchaseTo: filters.purchaseTo } : {}),
			...(filters.campaignIds?.length ? { campaignIds: filters.campaignIds.join(",") } : {}),
			...(filters.segmentIds?.length ? { segmentIds: filters.segmentIds.join(",") } : {}),
			...(filters.registeredFrom ? { registeredFrom: filters.registeredFrom } : {}),
			...(filters.registeredTo ? { registeredTo: filters.registeredTo } : {}),
			...(filters.loyaltyOperatorIds?.length
				? { loyaltyOperatorIds: filters.loyaltyOperatorIds.join(",") }
				: {}),
		};

		for (let page = 1; ; page++) {
			const response = await this.customersService.getCustomers({
				...requestFilters,
				instance: this.instance,
				page: String(page),
			} as any);

			this.extractCustomerIds(response.data, ids);
			const totalRows = Number(response.page?.totalRows ?? response.data?.length ?? 0);
			if (page * perPage >= totalRows || !response.data?.length) break;
		}

		return Array.from(ids);
	}

	private extractCustomerIds(data: any[] | undefined, ids: Set<number>): void {
		(data || []).forEach((c: any) => {
			if (typeof c?.CODIGO === "number" && Number.isFinite(c.CODIGO)) {
				ids.add(c.CODIGO);
			}
		});
	}
}

// ============================================================================
// Contact Enricher - Enriquece contatos com dados de cliente e chat
// ============================================================================

class ContactEnricher {
	private instance: string;

	constructor(instance: string, private readonly customersService: CustomersClient, private readonly usersService: UsersClient) {
		this.instance = instance;
	}

	async enrich(contacts: any[]): Promise<EnrichedContact[]> {
		if (contacts.length === 0) return [];

		const customerIds = this.extractUniqueCustomerIds(contacts);

		// Busca paralela de chats e clientes
		const [chats, customersMap] = await Promise.all([
			this.fetchActiveChats(),
			this.fetchCustomers(customerIds)
		]);

		const chatsMap = this.buildChatsMap(chats);

		// Enriquece cada contato
		return Promise.all(
			contacts.map((contact) => this.enrichContact(contact, customersMap, chatsMap))
		);
	}

	private extractUniqueCustomerIds(contacts: any[]): number[] {
		const ids = new Set<number>();
		contacts.forEach((c) => {
			if (typeof c.customerId === "number" && Number.isFinite(c.customerId)) {
				ids.add(c.customerId);
			}
		});
		return Array.from(ids);
	}

	private async fetchActiveChats(): Promise<any[]> {
		try {
			const chats = await chatsService.getChats({ isFinished: "false" });
			return Array.isArray(chats) ? chats : [];
		} catch {
			return [];
		}
	}

	private async fetchCustomers(customerIds: number[]): Promise<Map<number, Customer>> {
		const result = new Map<number, Customer>();
		if (customerIds.length === 0) return result;

		const batchSize = 10;

		for (let i = 0; i < customerIds.length; i += batchSize) {
			const batch = customerIds.slice(i, i + batchSize);

			await Promise.all(
				batch.map(async (id) => {
					try {
						const resp = await this.customersService.getCustomers({
							instance: this.instance,
							CODIGO: id.toString(),
							perPage: "1"
						} as any);

						const customer = resp?.data?.[0];
						if (customer?.CODIGO) {
							result.set(customer.CODIGO, customer);
						}
					} catch (err) {
						Logger.debug(`[ContactEnricher] Erro ao buscar cliente ${id}: ${err}`);
					}
				})
			);
		}

		return result;
	}

	private buildChatsMap(chats: any[]): Map<number, any> {
		return new Map(chats.map((chat) => [chat.contactId, chat]));
	}

	private async enrichContact(
		contact: any,
		customersMap: Map<number, Customer>,
		chatsMap: Map<number, any>
	): Promise<EnrichedContact> {
		const customer = contact.customerId ? customersMap.get(contact.customerId) ?? null : null;
		const chat = chatsMap.get(contact.id);
		const chatingWith = await this.resolveChatingWith(chat);

		return {
			...contact,
			customer,
			chatingWith
		};
	}

	private async resolveChatingWith(chat: any): Promise<string | null> {
		if (!chat?.userId) return null;

		try {
			const user = await this.usersService.getUserById(chat.userId);
			return user?.NOME || "Supervisão";
		} catch {
			return "Supervisão";
		}
	}
}

// ============================================================================
// Contact Search Service - Serviço principal de busca
// ============================================================================

class ContactSearchService {
	private customersService: CustomersClient;
	private usersService: UsersClient;


	constructor(token: string) {
		const normalized = token.replace(/^Bearer\s+/i, "");
		this.customersService = getCustomersClient();
		this.usersService = getUsersClient();
		this.customersService.setAuth(normalized);
		this.usersService.setAuth(normalized);
	}

	async search(
		instance: string,
		filters: ContactSearchFilters,
		pagination: PaginationParams
	): Promise<PaginatedResult<EnrichedContact>> {
		const page = Math.max(1, pagination.page);
		const perPage = Math.max(1, Math.min(100, pagination.perPage));

		// 1. Busca IDs de clientes se houver filtros de cliente
		const customerSearcher = new CustomerSearcher(instance, this.customersService);
		const matchedCustomerIds = await customerSearcher.searchByFilters(filters);

		// Se buscou por filtros de cliente mas não encontrou nenhum, retorna vazio
		if (matchedCustomerIds !== null && matchedCustomerIds.length === 0) {
			return this.emptyResult(page, perPage);
		}

		// 2. Constrói query de contatos
		const queryBuilder = new ContactQueryBuilder(instance)
			.withIds(filters.ids)
			.withId(filters.id)
			.withName(filters.name)
			.withPhone(filters.phone)
			.withSectors(filters.sectorIds);

		// Aplica filtros de cliente de forma combinada
		if (filters.customerIds && filters.customerIds.length > 0) {
			queryBuilder.withCustomerIds(filters.customerIds);
		} else if (matchedCustomerIds !== null) {
			queryBuilder.withCustomerIds(matchedCustomerIds);
		}
		if (filters.customerId !== null && filters.customerId !== undefined) {
			queryBuilder.withCustomerId(filters.customerId);
		}
		if (filters.hasCustomer !== null && filters.hasCustomer !== undefined) {
			queryBuilder.withHasCustomer(filters.hasCustomer);
		}

		const whereConditions = queryBuilder.build();
		// 3. Executa busca no banco
		const [contacts, total] = await Promise.all([
			prismaService.wppContact.findMany({
				where: whereConditions,
				include: { sectors: true } as any,
				skip: (page - 1) * perPage,
				take: perPage,
				orderBy: { id: "desc" }
			}),
			prismaService.wppContact.count({ where: whereConditions })
		]);

		if (contacts.length === 0) {
			return this.emptyResult(page, perPage);
		}

		// 4. Enriquece contatos com dados de cliente e chat
		const enricher = new ContactEnricher(instance, this.customersService, this.usersService);
		const enrichedContacts = await enricher.enrich(contacts);
		const totalPages = Math.ceil(total / perPage);


		return {
			data: enrichedContacts,
			pagination: {
				page,
				perPage,
				total,
				totalPages,
				hasNext: page < totalPages,
				hasPrev: page > 1
			}
		};
	}

	private emptyResult(page: number, perPage: number): PaginatedResult<EnrichedContact> {
		return {
			data: [],
			pagination: {
				page,
				perPage,
				total: 0,
				totalPages: 0,
				hasNext: false,
				hasPrev: false
			}
		};
	}
}

export default ContactSearchService;
