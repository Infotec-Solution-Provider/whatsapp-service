import { Customer } from "@in.pulse-crm/sdk";
import { Prisma } from "@prisma/client";
import { Logger } from "@in.pulse-crm/utils";
import chatsService from "./chats.service";
import customersService from "./customers.service";
import prismaService from "./prisma.service";
import usersService from "./users.service";

// ============================================================================
// Types
// ============================================================================

export interface ContactSearchFilters {
	id?: number | null;
	name?: string | null;
	phone?: string | null;
	customerId?: number | null;
	customerErp?: string | null;
	customerCnpj?: string | null;
	customerName?: string | null;
	hasCustomer?: boolean | null;
	sectorIds?: number[] | null;
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

	constructor(instance: string) {
		this.instance = instance;
	}

	async searchByFilters(filters: ContactSearchFilters): Promise<number[] | null> {
		const hasFilters = !!(filters.customerErp || filters.customerCnpj || filters.customerName);
		if (!hasFilters) {
			return null; // Null significa "sem filtro de cliente"
		}

		const ids = new Set<number>();

		// Busca paralela por ERP e CNPJ (são independentes)
		await Promise.all([
			this.searchByErp(filters.customerErp, ids),
			this.searchByCnpj(filters.customerCnpj, ids)
		]);

		// Busca por nome apenas se não encontrou por ERP/CNPJ
		if (ids.size === 0 && filters.customerName?.trim()) {
			await this.searchByName(filters.customerName, ids);
		}

		return Array.from(ids);
	}

	private async searchByErp(erp: string | null | undefined, ids: Set<number>): Promise<void> {
		const erpRaw = erp?.trim();
		if (!erpRaw) return;

		try {
			// Busca por COD_ERP exato
			const { data } = await customersService.getCustomers({
				instance: this.instance,
				COD_ERP: erpRaw,
				perPage: "10"
			} as any);

			this.extractCustomerIds(data, ids);

			// Se for numérico, também tenta por CODIGO
			const erpDigits = erpRaw.replace(/\D/g, "");
			if (erpDigits) {
				const { data: dataById } = await customersService.getCustomers({
					instance: this.instance,
					CODIGO: erpDigits,
					perPage: "1"
				} as any);
				this.extractCustomerIds(dataById, ids);
			}
		} catch (err) {
			Logger.error(`[CustomerSearcher] Erro ao buscar por ERP: ${err}`);
		}
	}

	private async searchByCnpj(cnpj: string | null | undefined, ids: Set<number>): Promise<void> {
		const digits = cnpj?.replace(/\D/g, "");
		if (!digits) return;

		try {
			const { data } = await customersService.getCustomers({
				instance: this.instance,
				CPF_CNPJ: digits,
				perPage: "10"
			} as any);
			this.extractCustomerIds(data, ids);
		} catch (err) {
			Logger.error(`[CustomerSearcher] Erro ao buscar por CPF/CNPJ: ${err}`);
		}
	}

	private async searchByName(name: string | null | undefined, ids: Set<number>): Promise<void> {
		const trimmed = name?.trim();
		if (!trimmed) return;

		const maxPages = 5;
		const perPage = 50;

		for (let page = 1; page <= maxPages; page++) {
			try {
				const { data } = await customersService.getCustomers({
					instance: this.instance,
					RAZAO: trimmed,
					page: page.toString(),
					perPage: perPage.toString()
				} as any);

				this.extractCustomerIds(data, ids);

				// Se encontrou resultados ou não há mais páginas, para
				if (ids.size > 0 || !data || data.length < perPage) break;
			} catch (err) {
				Logger.error(`[CustomerSearcher] Erro ao buscar por nome: ${err}`);
				break;
			}
		}
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

	constructor(instance: string) {
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
						const resp = await customersService.getCustomers({
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
			const user = await usersService.getUserById(chat.userId);
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
	/**
	 * Configura autenticação para os serviços externos
	 */
	setAuth(token: string): void {
		const normalized = token.replace(/^Bearer\s+/i, "");
		if (normalized) {
			customersService.setAuth(normalized);
			usersService.setAuth(normalized);
		}
	}

	/**
	 * Busca contatos com filtros e enriquecimento de dados
	 */
	async search(
		instance: string,
		filters: ContactSearchFilters,
		pagination: PaginationParams
	): Promise<PaginatedResult<EnrichedContact>> {
		const startTime = Date.now();
		Logger.debug(`[ContactSearchService] START - instance: ${instance}`);
		Logger.debug(`[ContactSearchService] filters: ${JSON.stringify(filters)}`);

		const page = Math.max(1, pagination.page);
		const perPage = Math.max(1, Math.min(100, pagination.perPage));

		// 1. Busca IDs de clientes se houver filtros de cliente
		const customerSearcher = new CustomerSearcher(instance);
		const matchedCustomerIds = await customerSearcher.searchByFilters(filters);

		// Se buscou por filtros de cliente mas não encontrou nenhum, retorna vazio
		if (matchedCustomerIds !== null && matchedCustomerIds.length === 0) {
			Logger.debug("[ContactSearchService] Nenhum cliente encontrado para os filtros");
			return this.emptyResult(page, perPage);
		}

		// 2. Constrói query de contatos
		const queryBuilder = new ContactQueryBuilder(instance)
			.withId(filters.id)
			.withName(filters.name)
			.withPhone(filters.phone)
			.withSectors(filters.sectorIds);

		// Aplica filtros de cliente de forma combinada
		if (matchedCustomerIds !== null) {
			queryBuilder.withCustomerIds(matchedCustomerIds);
		}
		if (filters.customerId !== null && filters.customerId !== undefined) {
			queryBuilder.withCustomerId(filters.customerId);
		}
		if (filters.hasCustomer !== null && filters.hasCustomer !== undefined) {
			queryBuilder.withHasCustomer(filters.hasCustomer);
		}

		const whereConditions = queryBuilder.build();
		Logger.debug(`[ContactSearchService] Query: ${JSON.stringify(whereConditions)}`);

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

		Logger.debug(`[ContactSearchService] Encontrados: ${contacts.length}, Total: ${total}`);

		if (contacts.length === 0) {
			return this.emptyResult(page, perPage);
		}

		// 4. Enriquece contatos com dados de cliente e chat
		const enricher = new ContactEnricher(instance);
		const enrichedContacts = await enricher.enrich(contacts);

		const totalPages = Math.ceil(total / perPage);
		Logger.debug(`[ContactSearchService] END - ${Date.now() - startTime}ms`);

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

export default new ContactSearchService();
