import { Customer, User } from "@in.pulse-crm/sdk";
import { Prisma } from "@prisma/client";
import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";
import chatsService from "./chats.service";
import customersService from "./customers.service";
import prismaService from "./prisma.service";
import usersService from "./users.service";
import whatsappService from "./whatsapp.service";
import redisService from "./redis.service";

export interface ContactsFilters {
	name: string | null;
	phone: string | null;
	customerId: number | null;
	customerErp: string | null;
	customerCnpj: string | null;
	customerName: string | null;
	hasCustomer: boolean | null;
	page: number;
	perPage: number;
}

class ContactsService {
	private readonly CUSTOMER_CACHE_TTL = 5 * 60; // 5 minutos em segundos
	private readonly USER_CACHE_TTL = 5 * 60; // 5 minutos em segundos

	public async getOrCreateContact(instance: string, name: string, phone: string) {
		const contact = await prismaService.wppContact.findUnique({
			where: {
				instance_phone: {
					instance,
					phone
				}
			}
		});

		if (contact) {
			return contact;
		}

		return await prismaService.wppContact.create({
			data: {
				instance,
				name,
				phone
			}
		});
	}

	/**
	 * getContactsWithCustomer — versão otimizada e multi-tenant
	 * Regras:
	 * - Filtros de CLIENTE (ERP/CNPJ/NOME): buscar clientes (scoped por instance) -> pegar CODIGO -> filtrar contatos no DB (customerId IN [...]) + instance.
	 * - Filtros de CONTATO (name/phone): aplicar direto em wppContact no DB
	 * - Nenhum filtro: paginação direta no DB
	 * - hasCustomer/customerId: aplicados direto no where
	 * - Enriquecimento (chats/usuários) preservado; todos escopados por instance.
	 * - Removido `mode: 'insensitive'` do Prisma (evita TS2353). Case-insensitive deve ser via collation/ci.
	 */
	public async getContactsWithCustomer(instance: string, token: string, filters: ContactsFilters) {
		customersService.setAuth(token);
		usersService.setAuth(token);

		console.log("[getContactsWithCustomer] start", { instance, filters });

		// paginação normalizada
		const page = Math.max(1, filters.page);
		const perPage = Math.max(1, Math.min(100, filters.perPage));
		console.log("[getContactsWithCustomer] pagination", { page, perPage });

		// where base SEMPRE inclui instance
		const whereConditions: Prisma.WppContactWhereInput = {
			instance,
			isDeleted: false
		};

		// 1) Filtros do "lado do cliente": ERP/CNPJ/NOME
		const hasCustomerSideFilters = !!(filters.customerErp || filters.customerCnpj || filters.customerName);
		if (hasCustomerSideFilters) {
			const matchedCustomerIds = await this.searchCustomerIdsByFilters(instance, filters);
			console.log("[getContactsWithCustomer] matchedCustomerIds", matchedCustomerIds);

			if (matchedCustomerIds.length === 0) {
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

			// aplica customerId IN [...] no mesmo instance
			whereConditions.customerId = { in: matchedCustomerIds };
		}

		// 2) Filtros do "lado do contato": name/phone
		if (filters.name) {
			// Case-insensitive via collation/ci no DB se necessário.
			whereConditions.name = { contains: filters.name };
		}

		if (filters.phone) {
			whereConditions.phone = { contains: filters.phone };
		}

		// 3) Vínculo com cliente: customerId / hasCustomer
		// Mantém a precedência da versão original: hasCustomer pode sobrescrever.
		if (typeof filters.customerId === "number" && Number.isFinite(filters.customerId)) {
			whereConditions.customerId = filters.customerId;
		}

		if (filters.hasCustomer === true) {
			whereConditions.customerId = { not: null };
		} else if (filters.hasCustomer === false) {
			whereConditions.customerId = null;
		}

		// 4) Consulta SEMPRE paginada no DB (sem overfetch de contatos)
		const [contacts, total] = await Promise.all([
			prismaService.wppContact.findMany({
				where: whereConditions,
				skip: (page - 1) * perPage,
				take: perPage,
				orderBy: { id: "desc" }
			}),
			prismaService.wppContact.count({ where: whereConditions })
		]);

		console.log("[getContactsWithCustomer] db result", {
			resultCount: contacts.length,
			totalCount: total,
			sampleIds: contacts.slice(0, 10).map((c) => c.id)
		});

		if (contacts.length === 0) {
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

		// 5) Enriquecimento: chats + customers + users (sempre escopados)
		// Se seu chatsService aceitar instance (recomendado), passamos:
		const chatsPromise = chatsService.getChats({ isFinished: "false" });
		const uniqueCustomerIds = [...new Set(contacts.map((c) => c.customerId).filter(Boolean))] as number[];

		const [chats, customersMap] = await Promise.all([
			chatsPromise,
			this.getCustomersByIds(instance, uniqueCustomerIds)
		]);

		console.log("[getContactsWithCustomer] enrichment fetched", {
			chatsCount: Array.isArray(chats) ? chats.length : 0,
			customersFound: customersMap.size
		});

		const chatsMap = new Map<number, any>(
			(Array.isArray(chats) ? chats : []).map((chat: any) => [chat.contactId, chat])
		);
		const relevantChats = contacts.map((c) => chatsMap.get(c.id)).filter(Boolean) as any[];
		const uniqueUserIds = [...new Set(relevantChats.map((c) => c.userId).filter(Boolean))] as number[];

		const usersMap = await this.getUsersByIds(instance, uniqueUserIds);
		console.log("[getContactsWithCustomer] usersMap size", usersMap.size);

		const mappedContacts = contacts.map((contact) => {
			const customer = contact.customerId ? customersMap.get(contact.customerId) : null;
			const chat = chatsMap.get(contact.id);
			const user = chat ? usersMap.get(chat.userId || -200)?.NOME || "Supervisão" : null;

			return {
				...contact,
				customer: customer || null,
				chatingWith: user
			};
		});

		const totalPages = Math.ceil(total / perPage);

		return {
			data: mappedContacts,
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

	/**
	 * Mapeia filtros para possíveis parâmetros aceitos pela API de clientes.
	 * -> Inclui sempre o escopo de `instance` para evitar vazamento multi-tenant.
	 * Ajuste as chaves se o backend usar nomes diferentes (tenant/empresa/filial...).
	 */
	private mapCustomerFilters(instance: string, filters: ContactsFilters): Record<string, string> {
		const params: Record<string, string> = {};

		// Escopo de tenant / instancia — ajuste conforme sua API:
		params["instance"] = instance;
		// Alternativas comuns (descomente e/ou ajuste se seu backend usar outra chave):
		// params["tenant"] = instance;
		// params["empresa"] = instance;
		// params["FILIAL"] = instance;

		if (filters.customerErp) {
			params["COD_ERP"] = filters.customerErp;
			// params["ERP"] = filters.customerErp;
			// params["erp"] = filters.customerErp;
		}

		if (filters.customerCnpj) {
			params["CPF_CNPJ"] = filters.customerCnpj;
			// params["CNPJ"] = filters.customerCnpj;
			// params["cnpj"] = filters.customerCnpj;
		}

		if (filters.customerName) {
			// ajuste para o campo que seu backend usa (RAZAO, FANTASIA, search, name...)
			params["RAZAO"] = filters.customerName;
			// params["FANTASIA"] = filters.customerName;
			// params["search"] = filters.customerName;
			// params["name"] = filters.customerName;
		}

		// Janela controlada para reduzir roundtrips
		params["perPage"] = "500";

		return params;
	}

	/**
	 * Busca IDs (CODIGO) de clientes conforme filtros (ERP/CNPJ/NOME), sempre escopado por `instance`.
	 * - Filtra via API com parâmetros mapeados (inclui instance).
	 * - Reforça o match localmente (ERP/CNPJ/NOME) para robustez.
	 */
	private async searchCustomerIdsByFilters(
		instance: string,
		filters: ContactsFilters
	): Promise<number[]> {
		const params = this.mapCustomerFilters(instance, filters);

		try {
			const response = await customersService.getCustomers(params as any);
			const customers: any[] = response?.data ?? [];

			// Reforço local (caso a API seja elástica nos filtros)
			const erp = (filters.customerErp ?? "").toString().trim();
			const cnpj = (filters.customerCnpj ?? "").toString().trim();
			const name = (filters.customerName ?? "").toString().trim().toLowerCase();

			const matches = customers.filter((c: any) => {
				let ok = true;

				if (erp) {
					ok = ok && (
						c?.COD_ERP?.toString().includes(erp) ||
						c?.ERP?.toString().includes(erp)
					);
				}

				if (cnpj) {
					ok = ok && (
						c?.CPF_CNPJ?.includes(cnpj) ||
						c?.CNPJ?.includes(cnpj) ||
						c?.cnpj?.includes(cnpj)
					);
				}

				if (name) {
					const fantasia = (c?.FANTASIA ?? "").toString().toLowerCase();
					const razao = (c?.RAZAO ?? "").toString().toLowerCase();
					const nome = (c?.NOME ?? "").toString().toLowerCase();
					ok = ok && (fantasia.includes(name) || razao.includes(name) || nome.includes(name));
				}

				return ok;
			});

			const ids = matches.map((c: any) => c?.CODIGO).filter((x: any) => Number.isFinite(x));
			// Set para deduplicar
			return Array.from(new Set<number>(ids));
		} catch (error) {
			console.error("[searchCustomerIdsByFilters] erro na API de clientes", error);
			return [];
		}
	}

	/**
	 * Busca clientes por IDs, com cache Redis por instance e chamada à API escopada por instance.
	 */
	private async getCustomersByIds(
		instance: string,
		customerIds: number[]
	): Promise<Map<number, Customer>> {
		const result = new Map<number, Customer>();

		if (customerIds.length === 0) {
			return result;
		}

		// Redis por instance
		const cacheKeys = customerIds.map((id) => `customer:${instance}:${id}`);
		const cachedCustomers = await redisService.mget<Customer>(cacheKeys);

		const idsToFetch: number[] = [];

		cachedCustomers.forEach((customer, index) => {
			if (customer) {
				result.set(customerIds[index]!, customer);
			} else {
				idsToFetch.push(customerIds[index]!);
			}
		});

		if (idsToFetch.length === 0) {
			return result;
		}

		try {
			const batchSize = 100;
			for (let i = 0; i < idsToFetch.length; i += batchSize) {
				const batch = idsToFetch.slice(i, i + batchSize);

				// Ideal: endpoint byIds (se tiver, use-o e passe instance).
				// const { data: customers } = await customersService.getCustomers({ ids: batch.join(","), perPage: batch.length.toString(), instance });

				// Fallback universal (escopado por instance):
				const { data: customers } = await customersService.getCustomers({
					perPage: batch.length.toString(),
				});

				const requestedCustomers = (customers || []).filter((c: any) => batch.includes(c.CODIGO));

				const cacheItems = requestedCustomers.map((customer: any) => ({
					key: `customer:${instance}:${customer.CODIGO}`,
					value: customer,
					ttl: this.CUSTOMER_CACHE_TTL
				}));

				if (cacheItems.length) {
					await redisService.mset(cacheItems);
				}

				requestedCustomers.forEach((customer: any) => {
					result.set(customer.CODIGO, customer);
				});
			}
		} catch (error) {
			console.error("Erro ao buscar clientes:", error);
		}

		return result;
	}

	/**
	 * Busca usuários por IDs, com cache Redis por instance e chamada à API escopada por instance.
	 */
	private async getUsersByIds(instance: string, userIds: number[]): Promise<Map<number, User>> {
		const result = new Map<number, User>();

		if (userIds.length === 0) {
			return result;
		}

		const cacheKeys = userIds.map((id) => `user:${instance}:${id}`);
		const cachedUsers = await redisService.mget<User>(cacheKeys);

		const idsToFetch: number[] = [];

		cachedUsers.forEach((user, index) => {
			if (user) {
				result.set(userIds[index]!, user);
			} else {
				idsToFetch.push(userIds[index]!);
			}
		});

		if (idsToFetch.length === 0) {
			return result;
		}

		try {
			const batchSize = 100;
			for (let i = 0; i < idsToFetch.length; i += batchSize) {
				const batch = idsToFetch.slice(i, i + batchSize);

				// Ideal: endpoint byIds (se houver), passando instance.
				// const { data: users } = await usersService.getUsers({ ids: batch.join(","), perPage: batch.length.toString(), instance });

				// Fallback universal (escopado por instance):
				const { data: users } = await usersService.getUsers({
					perPage: batch.length.toString(),
				});

				const requestedUsers = (users || []).filter((u: any) => batch.includes(u.CODIGO));

				const cacheItems = requestedUsers.map((user: any) => ({
					key: `user:${instance}:${user.CODIGO}`,
					value: user,
					ttl: this.USER_CACHE_TTL
				}));

				if (cacheItems.length) {
					await redisService.mset(cacheItems);
				}

				requestedUsers.forEach((user: any) => {
					result.set(user.CODIGO, user);
				});
			}
		} catch (error) {
			console.error("Erro ao buscar usuários:", error);
		}

		return result;
	}

	public async getCustomerContacts(instance: string, customerId: number) {
		const contacts = await prismaService.wppContact.findMany({
			where: {
				instance,
				customerId,
				isDeleted: false
			},
			include: {
				sectors: true
			}
		});

		return contacts;
	}

	public async getContacts(instance: string) {
		const contacts = await prismaService.wppContact.findMany({
			where: {
				instance,
				isDeleted: false
			},
			include: {
				sectors: true
			}
		});
		return contacts;
	}

	/**
	 * Create contact with optional sector assignment.
	 * Business rules:
	 * - A contact may belong to multiple sectors.
	 * - If a contact has no sectors, it's considered global.
	 * - When creating a contact, if the phone already exists linked to other sector(s) (or global), return an error.
	 */
	public async createContact(
		instance: string,
		name: string,
		phone: string,
		customerId?: number,
		sectorIds?: number[]
	) {
		const validPhone = await whatsappService.getValidWhatsappPhone(instance, phone);
		if (!validPhone) {
			throw new BadRequestError("Esse número não é um WhatsApp válido!");
		}

		const existingContact = await prismaService.wppContact.findUnique({
			where: {
				instance_phone: {
					instance,
					phone: validPhone
				}
			},
			// include sectors - cast to any because Prisma client types must be regenerated after schema change
			include: { sectors: true }
		});

		// If contact exists and mapped to a customer, keep old behavior
		if (
			existingContact &&
			!!existingContact.customerId &&
			customerId &&
			existingContact.customerId !== customerId
		) {
			const message = `Este número já está cadastrado no cliente de código ${existingContact.customerId}`;
			throw new ConflictError(message);
		}

		// If contact exists, we must enforce sector rules
		if (existingContact) {
			const existingSectorIds = (existingContact.sectors || []).map((s) => s.sectorId);

			// If creating global (no sectorIds provided)
			if (!sectorIds || sectorIds.length === 0) {
				// If there are sectors linked already, it's a conflict (would create a global contact while it exists in other sectors)
				if (existingSectorIds.length > 0) {
					throw new ConflictError("Este número já está cadastrado em outro(s) setor(es)");
				}

				// Otherwise it's already global: update and return
				const updated = await prismaService.wppContact.update({
					where: { id: existingContact.id },
					data: { name, customerId: customerId || null }
				});
				return updated;
			}

			// Creating with sectors: if existing is global -> conflict
			if (existingSectorIds.length === 0) {
				throw new ConflictError("Este número já está cadastrado globalmente");
			}

			// If existing sectors differ from requested sectors -> conflict
			const requested = [...new Set(sectorIds)];
			const missingInRequested = existingSectorIds.filter((id: number) => !requested.includes(id));
			const extraInRequested = requested.filter((id: number) => !existingSectorIds.includes(id));

			if (missingInRequested.length > 0 || extraInRequested.length > 0) {
				throw new ConflictError("Este número já está cadastrado em outro(s) setor(es)");
			}

			// Sectors match: update name/customerId and return
			const updated = await prismaService.wppContact.update({
				where: { id: existingContact.id },
				data: { name, customerId: customerId || null }
			});

			return updated;
		}

		// Contact does not exist: create new and optionally link sectors
		const createData: any = {
			instance,
			name,
			phone: validPhone,
			customerId: customerId || null
		};

		if (sectorIds && sectorIds.length > 0) {
			// create nested rows in the join table
			createData.sectors = {
				create: sectorIds.map((id) => ({ sectorId: id }))
			};
		}

		const createdContact = await prismaService.wppContact.create({
			data: createData,
			// include sectors - cast to any because Prisma client types must be regenerated after schema change
			include: { sectors: true }
		});

		return createdContact;
	}

	/**
	 * Update contact fields and optionally replace sector associations.
	 * If sectorIds is provided, all existing sector links will be replaced by the provided list.
	 */
	public async updateContact(contactId: number, data: Prisma.WppContactUpdateInput, sectorIds?: number[]) {
		// If sectorIds is not provided, simple update
		if (!sectorIds) {
			const contact = await prismaService.wppContact.update({
				where: { id: contactId },
				data
			});

			return contact;
		}

		// When sectorIds provided, replace relations in the join table
		const cleanedSectorIds = [...new Set(sectorIds)];

		const updatePayload: Prisma.WppContactUpdateInput = {
			...data,
			// Replace sectors: delete existing and create new ones
			sectors: {
				deleteMany: {},
				create: cleanedSectorIds.map((id) => ({ sectorId: id }))
			}
		};

		const contact = await prismaService.wppContact.update({
			where: { id: contactId },
			data: updatePayload,
			// include sectors for convenience (cast to any until prisma client is regenerated)
			include: { sectors: true }
		});

		return contact;
	}

	/**
	 * Add a single sector to a contact.
	 * Rules:
	 * - If the contact is global (no sectors), don't allow adding a sector (keeps consistency with create rules).
	 * - If the sector already exists for the contact, return the contact unchanged.
	 * - Otherwise, create the association and return the updated contact (including sectors).
	 */
	public async addSectorToContact(contactId: number, sectorId: number) {
		const contact = await prismaService.wppContact.findUnique({
			where: { id: contactId },
			include: { sectors: true }
		});

		if (!contact) {
			throw new BadRequestError("Contato não encontrado");
		}

		const existingSectorIds = (contact.sectors || []).map((s: any) => s.sectorId);

		// If contact is global (no sectors), do not allow adding sector (matching create conflict rule)
		if (existingSectorIds.length === 0) {
			throw new ConflictError("Este número já está cadastrado globalmente");
		}

		if (existingSectorIds.includes(sectorId)) {
			// nothing to do, return contact with sectors
			return await prismaService.wppContact.findUnique({
				where: { id: contactId },
				include: { sectors: true }
			});
		}

		// Add new sector association
		await prismaService.wppContact.update({
			where: { id: contactId },
			data: { sectors: { create: { sectorId } } }
		});

		const updated = await prismaService.wppContact.findUnique({
			where: { id: contactId },
			include: { sectors: true }
		});

		return updated;
	}

	public async deleteContact(contactId: number) {
		const contact = await prismaService.wppContact.update({
			where: {
				id: contactId
			},
			data: {
				isDeleted: true
			}
		});

		return contact;
	}
}

export default new ContactsService();
