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

	public async getContactsWithCustomer(instance: string, token: string, filters: ContactsFilters) {
		customersService.setAuth(token);
		usersService.setAuth(token);

		// Normalizar e validar paginação
		const page = Math.max(1, filters.page);
		const perPage = Math.max(1, Math.min(100, filters.perPage));

		// Construir filtros para a consulta do banco
		const whereConditions: Prisma.WppContactWhereInput = {
			instance,
			isDeleted: false
		};

		// Aplicar filtros básicos de contato
		if (filters.name) {
			whereConditions.name = {
				contains: filters.name
			};
		}

		if (filters.phone) {
			whereConditions.phone = {
				contains: filters.phone
			};
		}

		if (filters.customerId) {
			whereConditions.customerId = filters.customerId;
		}

		if (filters.hasCustomer !== null) {
			if (filters.hasCustomer) {
				whereConditions.customerId = { not: null };
			} else {
				whereConditions.customerId = null;
			}
		}

		// OTIMIZAÇÃO 1: Se há filtros de cliente (customerErp, customerCnpj, customerName),
		// precisamos buscar todos e filtrar depois. Caso contrário, podemos paginar no banco.
		const hasCustomerFilters = !!(filters.customerErp || filters.customerCnpj || filters.customerName);

		let contacts: any[];
		let total: number;

		if (hasCustomerFilters) {
			// Com filtros de cliente, precisamos buscar todos e filtrar depois
			contacts = await prismaService.wppContact.findMany({
				where: whereConditions,
				orderBy: { id: "desc" }
			});
			total = contacts.length; // Será recalculado após filtros
		} else {
			// OTIMIZAÇÃO 2: Sem filtros de cliente, paginar direto no banco + count otimizado
			const [contactsResult, countResult] = await Promise.all([
				prismaService.wppContact.findMany({
					where: whereConditions,
					skip: (page - 1) * perPage,
					take: perPage,
					orderBy: { id: "desc" }
				}),
				prismaService.wppContact.count({
					where: whereConditions
				})
			]);

			contacts = contactsResult;
			total = countResult;
		}

		// Se não há contatos, retornar vazio imediatamente
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

		// OTIMIZAÇÃO 3: Buscar chats em paralelo
		const chatsPromise = chatsService.getChats({ isFinished: "false" });

		// Coletar IDs únicos de clientes necessários (apenas dos contatos retornados)
		const uniqueCustomerIds = [...new Set(contacts.map((c) => c.customerId).filter(Boolean))] as number[];

		// Buscar chats e dados de clientes em paralelo
		const [chats, customersMap] = await Promise.all([
			chatsPromise,
			this.getCustomersByIds(instance, uniqueCustomerIds)
		]);

		// OTIMIZAÇÃO 4: Criar Map de chats por contactId para lookup O(1)
		const chatsMap = new Map(chats.map((chat) => [chat.contactId, chat]));

		// Coletar IDs únicos de usuários (apenas dos chats relevantes)
		const relevantChats = contacts.map((c) => chatsMap.get(c.id)).filter(Boolean) as any[];
		const uniqueUserIds = [...new Set(relevantChats.map((c) => c.userId).filter(Boolean))] as number[];

		// Buscar usuários
		const usersMap = await this.getUsersByIds(instance, uniqueUserIds);

		// Mapear contatos com dados de cliente e usuário
		let mappedContacts = contacts.map((contact) => {
			const customer = contact.customerId && customersMap.get(contact.customerId);
			const chat = chatsMap.get(contact.id);

			// Gambiarra
			const user = chat ? usersMap.get(chat.userId || -200)?.NOME || "Supervisão" : null;

			return {
				...contact,
				customer: customer || null,
				chatingWith: user
			};
		});

		// Aplicar filtros de cliente (pós-processamento quando necessário)
		if (hasCustomerFilters) {
			mappedContacts = mappedContacts.filter((contact) => {
				if (!contact.customer) return false;

				let matches = true;

				if (filters.customerErp) {
					matches = matches && (contact.customer.COD_ERP?.toString().includes(filters.customerErp) ?? false);
				}

				if (filters.customerCnpj) {
					matches = matches && (contact.customer.CPF_CNPJ?.includes(filters.customerCnpj) ?? false);
				}

				if (filters.customerName) {
					const customerName = contact.customer.FANTASIA || contact.customer.RAZAO || "";
					matches = matches && customerName.toLowerCase().includes(filters.customerName.toLowerCase());
				}

				return matches;
			});

			// Recalcular total após filtros de cliente
			total = mappedContacts.length;

			// Aplicar paginação manual após filtros
			const startIndex = (page - 1) * perPage;
			const endIndex = startIndex + perPage;
			mappedContacts = mappedContacts.slice(startIndex, endIndex);
		}

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
	 * Busca clientes por IDs, primeiro tentando o Redis, depois a API
	 */
	private async getCustomersByIds(instance: string, customerIds: number[]): Promise<Map<number, Customer>> {
		const result = new Map<number, Customer>();

		if (customerIds.length === 0) {
			return result;
		}

		// Tentar buscar do Redis
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

		// Se todos estavam em cache, retornar
		if (idsToFetch.length === 0) {
			return result;
		}

		// Buscar da API apenas os que não estavam em cache
		try {
			// Buscar em lotes para evitar muitas requisições
			const batchSize = 100;
			for (let i = 0; i < idsToFetch.length; i += batchSize) {
				const batch = idsToFetch.slice(i, i + batchSize);
				const { data: customers } = await customersService.getCustomers({
					perPage: batch.length.toString()
				});

				// Filtrar apenas os clientes solicitados
				const requestedCustomers = customers.filter((c) => batch.includes(c.CODIGO));

				// Armazenar no Redis e no resultado
				const cacheItems = requestedCustomers.map((customer) => ({
					key: `customer:${instance}:${customer.CODIGO}`,
					value: customer,
					ttl: this.CUSTOMER_CACHE_TTL
				}));

				await redisService.mset(cacheItems);

				requestedCustomers.forEach((customer) => {
					result.set(customer.CODIGO, customer);
				});
			}
		} catch (error) {
			console.error("Erro ao buscar clientes:", error);
		}

		return result;
	}

	/**
	 * Busca usuários por IDs, primeiro tentando o Redis, depois a API
	 */
	private async getUsersByIds(instance: string, userIds: number[]): Promise<Map<number, User>> {
		const result = new Map<number, User>();

		if (userIds.length === 0) {
			return result;
		}

		// Tentar buscar do Redis
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

		// Se todos estavam em cache, retornar
		if (idsToFetch.length === 0) {
			return result;
		}

		// Buscar da API apenas os que não estavam em cache
		try {
			// Buscar em lotes para evitar muitas requisições
			const batchSize = 100;
			for (let i = 0; i < idsToFetch.length; i += batchSize) {
				const batch = idsToFetch.slice(i, i + batchSize);
				const { data: users } = await usersService.getUsers({
					perPage: batch.length.toString()
				});

				// Filtrar apenas os usuários solicitados
				const requestedUsers = users.filter((u) => batch.includes(u.CODIGO));

				// Armazenar no Redis e no resultado
				const cacheItems = requestedUsers.map((user) => ({
					key: `user:${instance}:${user.CODIGO}`,
					value: user,
					ttl: this.USER_CACHE_TTL
				}));

				await redisService.mset(cacheItems);

				requestedUsers.forEach((user) => {
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
			}
		});

		return contacts;
	}
	public async getContacts(instance: string) {
		const contacts = await prismaService.wppContact.findMany({
			where: {
				instance,
				isDeleted: false
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
