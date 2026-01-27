import { Customer, SessionData } from "@in.pulse-crm/sdk";
import { Prisma, WppContact } from "@prisma/client";
import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";
import { CustomerSchedule } from "../message-flow/base/base.step";
import chatsService from "./chats.service";
import customersService from "./customers.service";
import instancesService from "./instances.service";
import parametersService from "./parameters.service";
import prismaService from "./prisma.service";
import redisService from "./redis.service";
import usersService from "./users.service";

export interface ContactsFilters {
	name: string | null;
	phone: string | null;
	customerId: number | null;
	customerErp: string | null;
	customerCnpj: string | null;
	customerName: string | null;
	hasCustomer: boolean | null;
	sectorIds: number[] | null;
	page: number;
	perPage: number;
}

class ContactsService {
	private readonly CUSTOMER_CACHE_TTL = 5 * 60; // 5 minutos em segundos
	//private readonly USER_CACHE_TTL = 5 * 60; // 5 minutos em segundos

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

		const newContact = await prismaService.wppContact.create({
			data: {
				instance,
				name,
				phone
			}
		});

		await this.syncContactToLocal(newContact);

		return newContact;
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

		const page = Math.max(1, filters.page);
		const perPage = Math.max(1, Math.min(100, filters.perPage));

		const whereConditions: Prisma.WppContactWhereInput = {
			instance,
			isDeleted: false
		};

		const hasCustomerSideFilters = !!(filters.customerErp || filters.customerCnpj || filters.customerName);
		if (hasCustomerSideFilters) {
			const matchedCustomerIds = await this.searchCustomerIdsByFilters(instance, filters);

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

			whereConditions.customerId = { in: matchedCustomerIds };
		}

		if (filters.name) {
			whereConditions.name = { contains: filters.name };
		}

		if (filters.phone) {
			const phoneDigits = filters.phone.replace(/\D/g, "");
			if (phoneDigits) {
				whereConditions.phone = { contains: phoneDigits };
			}
		}

		if (typeof filters.customerId === "number" && Number.isFinite(filters.customerId)) {
			whereConditions.customerId = filters.customerId;
		}

		if (filters.hasCustomer === true) {
			whereConditions.customerId = { not: null };
		} else if (filters.hasCustomer === false) {
			whereConditions.customerId = null;
		}

		if (filters.sectorIds && filters.sectorIds.length > 0) {
			(whereConditions as any).sectors = {
				some: {
					sectorId: { in: filters.sectorIds }
				}
			};
		}

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

		const chatsPromise = chatsService.getChats({ isFinished: "false" });
		const uniqueCustomerIds = [...new Set(contacts.map((c) => c.customerId).filter(Boolean))] as number[];

		const [chats, customersMap] = await Promise.all([
			chatsPromise,
			this.getCustomersByIds(instance, uniqueCustomerIds)
		]);

		const chatsMap = new Map<number, any>(
			(Array.isArray(chats) ? chats : []).map((chat: any) => [chat.contactId, chat])
		);

		const mappedContacts = await Promise.all(
			contacts.map(async (contact) => {
				const customer = contact.customerId ? customersMap.get(contact.customerId) : null;
				const chat = chatsMap.get(contact.id);
				let chatingWith = null;
				if (chat?.userId) {
					try {
						const user = await usersService.getUserById(chat.userId);
						if (user?.NOME) {
							chatingWith = user.NOME;
						} else {
							chatingWith = "Supervisão";
						}
					} catch (error) {
						chatingWith = "Supervisão";
					}
				}

				return {
					...contact,
					customer: customer || null,
					chatingWith
				};
			})
		);
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

	public async getContactsWithCustomerLocally(instance: string, filters: ContactsFilters) {
		const page = Math.max(1, filters.page);
		const perPage = Math.max(1, Math.min(100, filters.perPage));

		const queryParams: any[] = [];
		const whereConditions: string[] = ["ctt.is_deleted = false"];

		// Filtros de contato
		if (filters.name) {
			whereConditions.push("ctt.name LIKE ?");
			queryParams.push(`%${filters.name}%`);
		}

		if (filters.phone) {
			const phoneDigits = filters.phone.replace(/\D/g, "");
			if (phoneDigits) {
				whereConditions.push("ctt.phone LIKE ?");
				queryParams.push(`%${phoneDigits}%`);
			}
		}

		if (typeof filters.customerId === "number" && Number.isFinite(filters.customerId)) {
			whereConditions.push("ctt.customer_id = ?");
			queryParams.push(filters.customerId);
		}

		if (filters.hasCustomer === true) {
			whereConditions.push("ctt.customer_id IS NOT NULL");
		} else if (filters.hasCustomer === false) {
			whereConditions.push("ctt.customer_id IS NULL");
		}

		// Filtros de cliente
		if (filters.customerErp) {
			whereConditions.push("cli.COD_ERP LIKE ?");
			queryParams.push(`%${filters.customerErp}%`);
		}

		if (filters.customerCnpj) {
			whereConditions.push("cli.CPF_CNPJ LIKE ?");
			queryParams.push(`%${filters.customerCnpj}%`);
		}

		if (filters.customerName) {
			whereConditions.push("(cli.RAZAO LIKE ? OR cli.FANTASIA LIKE ?)");
			queryParams.push(`%${filters.customerName}%`, `%${filters.customerName}%`);
		}

		// Filtros de setor
		if (filters.sectorIds && filters.sectorIds.length > 0) {
			const placeholders = filters.sectorIds.map(() => "?").join(",");
			whereConditions.push(`EXISTS (
				SELECT 1 FROM wpp_contact_sectors wcs 
				WHERE wcs.contact_id = ctt.id 
				AND wcs.sector_id IN (${placeholders})
			)`);
			queryParams.push(...filters.sectorIds);
		}

		const whereClause = whereConditions.join(" AND ");

		// Query de contagem
		const countQuery = `
			SELECT COUNT(*) as total
			FROM wpp_contacts ctt
			LEFT JOIN clientes cli ON ctt.customer_id = cli.CODIGO
			WHERE ${whereClause}
		`;

		const countResult = await instancesService.executeQuery<Array<{ total: number }>>(
			instance,
			countQuery,
			queryParams
		);
		const total = countResult[0]?.total || 0;

		if (total === 0) {
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

		// Query de dados com paginação
		const offset = (page - 1) * perPage;
		const dataQuery = `
			SELECT 
				ctt.*,
				cli.CODIGO as customer_CODIGO,
				cli.RAZAO as customer_RAZAO,
				cli.FANTASIA as customer_FANTASIA,
				cli.CPF_CNPJ as customer_CPF_CNPJ,
				cli.COD_ERP as customer_COD_ERP,
				cli.FONE1 as customer_TELEFONE,
				cli.FONE2 as customer_CELULAR,
				cli.EMAIL as customer_EMAIL,
				op.NOME as operator_NOME,
				GROUP_CONCAT(wcs.sector_id) as sector_ids
			FROM wpp_contacts ctt
			LEFT JOIN clientes cli ON ctt.customer_id = cli.CODIGO
			LEFT JOIN wpp_chats chat ON ctt.id = chat.contact_id AND chat.is_finished = false
			LEFT JOIN operadores op ON chat.user_id = op.CODIGO
			LEFT JOIN wpp_contact_sectors wcs ON ctt.id = wcs.contact_id
			WHERE ${whereClause}
			GROUP BY ctt.id, op.NOME
			ORDER BY ctt.id DESC
			LIMIT ? OFFSET ?
		`;

		// Create a new array with pagination params
		const dataQueryParams = [...queryParams, perPage, offset];

		const contacts = await instancesService.executeQuery<any[]>(instance, dataQuery, dataQueryParams);

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

		// Mapear contatos com dados enriquecidos
		const mappedContacts = contacts.map((row) => {
			const customer =
				row.customer_CODIGO !== null
					? {
						CODIGO: row.customer_CODIGO,
						RAZAO: row.customer_RAZAO,
						FANTASIA: row.customer_FANTASIA,
						NOME: row.customer_NOME,
						CPF_CNPJ: row.customer_CPF_CNPJ,
						COD_ERP: row.customer_COD_ERP,
						TELEFONE: row.customer_TELEFONE,
						CELULAR: row.customer_CELULAR,
						EMAIL: row.customer_EMAIL
					}
					: null;

			// Parsear sector_ids do GROUP_CONCAT
			const sectorIds = row.sector_ids
				? row.sector_ids.split(',').map((id: string) => parseInt(id, 10))
				: [];

			const chatingWith = row.operator_NOME || null;

			return {
				id: row.id,
				instance: row.instance,
				name: row.name,
				phone: row.phone,
				customerId: row.customer_id,
				isDeleted: row.is_deleted,
				sectors: sectorIds.map((sectorId: number) => ({ sectorId })),
				customer,
				chatingWith
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

	private mapCustomerFilters(instance: string, filters: ContactsFilters): Record<string, string> {
		const params: Record<string, string> = {};

		params["instance"] = instance;

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
			params["RAZAO"] = filters.customerName;
			// params["FANTASIA"] = filters.customerName;
			// params["search"] = filters.customerName;
			// params["name"] = filters.customerName;
		}

		params["perPage"] = "500";

		return params;
	}

	private async searchCustomerIdsByFilters(instance: string, filters: ContactsFilters): Promise<number[]> {
		const params = this.mapCustomerFilters(instance, filters);

		try {
			const response = await customersService.getCustomers(params as any);
			const customers: any[] = response?.data ?? [];

			const erp = (filters.customerErp ?? "").toString().trim();
			const cnpj = (filters.customerCnpj ?? "").toString().trim();
			const name = (filters.customerName ?? "").toString().trim().toLowerCase();

			const matches = customers.filter((c: any) => {
				let ok = true;

				if (erp) {
					ok = ok && (c?.COD_ERP?.toString().includes(erp) || c?.ERP?.toString().includes(erp));
				}

				if (cnpj) {
					ok = ok && (c?.CPF_CNPJ?.includes(cnpj) || c?.CNPJ?.includes(cnpj) || c?.cnpj?.includes(cnpj));
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
			return Array.from(new Set<number>(ids));
		} catch (error) {
			console.error("[searchCustomerIdsByFilters] erro na API de clientes", error);
			return [];
		}
	}

	private async getCustomersByIds(instance: string, customerIds: number[]): Promise<Map<number, Customer>> {
		const result = new Map<number, Customer>();

		if (customerIds.length === 0) {
			return result;
		}

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

				const { data: customers } = await customersService.getCustomers({
					perPage: batch.length.toString()
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

	public async getCustomerContacts(instance: string, customerId: number) {
		const contacts = await prismaService.wppContact.findMany({
			where: {
				instance,
				customerId,
				isDeleted: false
			},
			include: {
				sectors: true
			} as any
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
			} as any
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
		const existingContact = await prismaService.wppContact.findUnique({
			where: {
				instance_phone: {
					instance,
					phone
				}
			},
			// include sectors - cast to any because Prisma client types must be regenerated after schema change
			include: { sectors: true } as any
		});

		// If contact exists and mapped to a customer, keep old behavior
		if (existingContact && !!existingContact.customerId && customerId) {
			const message = `Este número já está cadastrado no cliente de código ${existingContact.customerId}`;
			throw new ConflictError(message);
		}

		// If contact exists, we must enforce sector rules
		if (existingContact) {
			const existingSectorIds = ((existingContact as any).sectors || []).map((s: any) => s.sectorId);

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
				await this.syncContactToLocal(updated);
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

			await this.syncContactToLocal(updated);

			return updated;
		}

		// Contact does not exist: create new and optionally link sectors
		const createData: any = {
			instance,
			name,
			phone,
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
			include: { sectors: true } as any
		});

		await this.syncContactToLocal(createdContact);
		if (sectorIds && sectorIds.length > 0) {
			await this.syncContactSectorsToLocal(createdContact.id, instance, sectorIds);
		}

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

			await this.syncContactToLocal(contact);

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
		} as any;

		const contact = await prismaService.wppContact.update({
			where: { id: contactId },
			data: updatePayload,
			// include sectors for convenience (cast to any until prisma client is regenerated)
			include: { sectors: true } as any
		});

		await this.syncContactToLocal(contact);
		await this.syncContactSectorsToLocal(contactId, contact.instance, cleanedSectorIds);

		return contact;
	}

	public async updateContactWrapper(
		session: SessionData,
		contactId: number,
		data: Prisma.WppContactUpdateInput,
		sectorIds?: number[]
	) {
		const parameters = await parametersService.getSessionParams(session);
		if (parameters["update_only_own_contacts"] === "true" && session.role !== "ADMIN") {
			const contact: WppContact = (await prismaService.wppContact.findUnique({
				where: { id: contactId }
			})) as WppContact;

			if (contact.customerId) {
				const loalty = await this.getContactLoalty(contact);
				if (!loalty || loalty.userId !== session.userId) {
					throw new BadRequestError("Você só pode atualizar contatos que estão fidelizados com você.");
				}
			}
		}
		return this.updateContact(contactId, data, sectorIds);
	}

	public async getContactLoalty(contact: WppContact) {
		if (!contact.customerId) {
			return null;
		}
		const schedule = await this.fetchCustomerSchedule(contact.instance, contact.customerId);
		if (!schedule) {
			return null;
		}

		return { userId: schedule.OPERADOR };
	}

	private async fetchCustomerSchedule(instance: string, customerId: number): Promise<CustomerSchedule | null> {
		const CHECK_LOALTY_QUERY = `SELECT * FROM campanhas_clientes cc
            WHERE cc.CLIENTE = ?
            ORDER BY CODIGO DESC LIMIT 1;`;
		const result = await instancesService.executeQuery<Array<CustomerSchedule>>(instance, CHECK_LOALTY_QUERY, [
			customerId
		]);
		return result[0] || null;
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
			include: { sectors: true } as any
		});

		if (!contact) {
			throw new BadRequestError("Contato não encontrado");
		}

		const existingSectorIds = ((contact as any).sectors || []).map((s: any) => s.sectorId);

		// If contact is global (no sectors), do not allow adding sector (matching create conflict rule)
		if (existingSectorIds.length === 0) {
			throw new ConflictError("Este número já está cadastrado globalmente");
		}

		if (existingSectorIds.includes(sectorId)) {
			// nothing to do, return contact with sectors
			return await prismaService.wppContact.findUnique({
				where: { id: contactId },
				include: { sectors: true } as any
			});
		}

		// Add new sector association
		const updated = await prismaService.wppContact.update({
			where: { id: contactId },
			data: { sectors: { create: { sectorId } } } as any,
			include: { sectors: true } as any
		});

		if (updated) {
			// Sync the contact itself
			await this.syncContactToLocal(updated);
			// Sync the sector associations
			const allSectorIds = ((updated as any).sectors || []).map((s: any) => s.sectorId);
			await this.syncContactSectorsToLocal(contactId, contact.instance, allSectorIds);
		}

		return updated;
	}

	public async deleteContact(contactId: number) {
		const contact = await prismaService.wppContact.update({
			where: {
				id: contactId
			},
			data: {
				isDeleted: true,
				customerId: null
			}
		});

		await this.syncContactToLocal(contact);

		return contact;
	}

	/**
	 * Sync contact to local database
	 */
	private async syncContactToLocal(contact: WppContact) {
		try {
			const query = `
				INSERT INTO wpp_contacts (id, instance, name, phone, customer_id, is_deleted)
				VALUES (?, ?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					name = VALUES(name),
					phone = VALUES(phone),
					customer_id = VALUES(customer_id),
					is_deleted = VALUES(is_deleted)
			`;

			await instancesService.executeQuery(
				contact.instance,
				query,
				[contact.id, contact.instance, contact.name, contact.phone, contact.customerId, contact.isDeleted]
			);
		} catch (error) {
			console.error("[syncContactToLocal] Erro ao sincronizar contato:", error);
		}
	}

	/**
	 * Sync contact sectors to local database
	 */
	private async syncContactSectorsToLocal(contactId: number, instance: string, sectorIds: number[]) {
		try {
			// Delete existing sectors
			const deleteQuery = "DELETE FROM wpp_contact_sectors WHERE contact_id = ?";
			await instancesService.executeQuery(instance, deleteQuery, [contactId]);

			// Insert new sectors
			if (sectorIds.length > 0) {
				const values = sectorIds.map((sectorId) => `(${contactId}, ${sectorId})`).join(", ");
				const insertQuery = `INSERT INTO wpp_contact_sectors (contact_id, sector_id) VALUES ${values}`;
				await instancesService.executeQuery(instance, insertQuery, []);
			}
		} catch (error) {
			console.error("[syncContactSectorsToLocal] Erro ao sincronizar setores:", error);
		}
	}
}

export default new ContactsService();
