import { Customer, SessionData } from "@in.pulse-crm/sdk";
import { Prisma, WppContact } from "@prisma/client";
import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";
import { CustomerSchedule } from "../message-flow/base/base.step";
import chatsService from "./chats.service";
import customersService from "./customers.service";
import instancesService from "./instances.service";
import parametersService from "./parameters.service";
import prismaService from "./prisma.service";
import usersService from "./users.service";
import whatsappService from "./whatsapp.service";
import { Logger } from "@in.pulse-crm/utils";

export interface ContactsFilters {
	id?: number | null;
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

	public async getContactsWithCustomer(instance: string, token: string, filters: ContactsFilters) {
		const startTime = Date.now();
		Logger.debug(`[getContactsWithCustomer] START - instance: ${instance}`);
		Logger.debug(`[getContactsWithCustomer] filters: ${JSON.stringify(filters, null, 2)}`);

		const normalizedToken = (token || "").replace(/^Bearer\s+/i, "");
		if (normalizedToken) {
			customersService.setAuth(normalizedToken);
			usersService.setAuth(normalizedToken);
			Logger.debug("[getContactsWithCustomer] Auth token set for customersService and usersService");
		}

		const page = Math.max(1, filters.page);
		const perPage = Math.max(1, Math.min(100, filters.perPage));
		Logger.debug(`[getContactsWithCustomer] Pagination - page: ${page}, perPage: ${perPage}`);

		const whereConditions: Prisma.WppContactWhereInput = {
			instance,
			isDeleted: false
		};

		const hasCustomerSideFilters = !!(filters.customerErp || filters.customerCnpj || filters.customerName);
		Logger.debug(`[getContactsWithCustomer] hasCustomerSideFilters: ${hasCustomerSideFilters}`);

		if (hasCustomerSideFilters) {
			const searchStart = Date.now();
			const matchedCustomerIds = await this.searchCustomerIdsByFilters(instance, filters);
			Logger.debug(`[getContactsWithCustomer] searchCustomerIdsByFilters took: ${Date.now() - searchStart}ms`);
			Logger.debug(`[getContactsWithCustomer] matchedCustomerIds: ${JSON.stringify(matchedCustomerIds)}`);

			if (matchedCustomerIds.length === 0) {
				Logger.debug("[getContactsWithCustomer] No matched customer IDs, returning empty result");
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
			Logger.debug(`[getContactsWithCustomer] Added name filter: ${filters.name}`);
		}

		if (typeof (filters as any).id === "number" && Number.isFinite((filters as any).id)) {
			(whereConditions as any).id = (filters as any).id;
			Logger.debug(`[getContactsWithCustomer] Added id filter: ${(filters as any).id}`);
		}

		if (filters.phone) {
			const phoneDigits = filters.phone.replace(/\D/g, "");
			if (phoneDigits) {
				whereConditions.phone = { contains: phoneDigits };
				Logger.debug(`[getContactsWithCustomer] Added phone filter: ${phoneDigits}`);
			}
		}

		if (typeof filters.customerId === "number" && Number.isFinite(filters.customerId)) {
			whereConditions.customerId = filters.customerId;
			Logger.debug(`[getContactsWithCustomer] Added customerId filter: ${filters.customerId}`);
		}

		if (filters.hasCustomer === true) {
			whereConditions.customerId = { not: null };
			Logger.debug("[getContactsWithCustomer] Filter hasCustomer: true");
		} else if (filters.hasCustomer === false) {
			whereConditions.customerId = null;
			Logger.debug("[getContactsWithCustomer] Filter hasCustomer: false");
		}

		if (filters.sectorIds && filters.sectorIds.length > 0) {
			(whereConditions as any).sectors = {
				some: {
					sectorId: { in: filters.sectorIds }
				}
			};
			Logger.debug(`[getContactsWithCustomer] Added sectorIds filter: ${JSON.stringify(filters.sectorIds)}`);
		}

		Logger.debug(`[getContactsWithCustomer] Final whereConditions: ${JSON.stringify(whereConditions, null, 2)}`);

		const dbQueryStart = Date.now();
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
		Logger.debug(`[getContactsWithCustomer] DB query took: ${Date.now() - dbQueryStart}ms`);
		Logger.debug(`[getContactsWithCustomer] Found contacts: ${contacts.length}, total: ${total}`);

		if (contacts.length === 0) {
			Logger.debug(`[getContactsWithCustomer] No contacts found, returning empty result. Total time: ${Date.now() - startTime}ms`);
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
		Logger.debug(`[getContactsWithCustomer] uniqueCustomerIds to fetch: ${uniqueCustomerIds.length}`);

		const enrichStart = Date.now();
		const [chats, customersMap] = await Promise.all([
			chatsPromise,
			this.getCustomersByIds(instance, uniqueCustomerIds)
		]);
		Logger.debug(`[getContactsWithCustomer] Chats and customers fetch took: ${Date.now() - enrichStart}ms`);
		Logger.debug(`[getContactsWithCustomer] Chats fetched: ${Array.isArray(chats) ? chats.length : 0}`);
		Logger.debug(`[getContactsWithCustomer] Customers fetched: ${customersMap.size}`);

		const chatsMap = new Map<number, any>(
			(Array.isArray(chats) ? chats : []).map((chat: any) => [chat.contactId, chat])
		);

		const mappingStart = Date.now();
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
						Logger.debug(`[getContactsWithCustomer] Error fetching user for chat: ${chat.userId} - ${error}`);
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
		Logger.debug(`[getContactsWithCustomer] Contact mapping took: ${Date.now() - mappingStart}ms`);

		const totalPages = Math.ceil(total / perPage);

		Logger.debug(`[getContactsWithCustomer] END - Total execution time: ${Date.now() - startTime}ms`);
		Logger.debug(`[getContactsWithCustomer] Returning ${mappedContacts.length} contacts, totalPages: ${totalPages}`);

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
			const sectorIds = typeof row.sector_ids === "string"
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

	private mapCustomerFilters(instance: string, filters: ContactsFilters, page = 1): Record<string, string> {
		const params: Record<string, string> = {
			instance,
			page: page.toString(),
			perPage: "50"
		};

		const name = (filters.customerName ?? "").trim();
		if (name) {
			params["RAZAO"] = name;
		}

		return params;
	}


	private async searchCustomerIdsByFilters(instance: string, filters: ContactsFilters): Promise<number[]> {
		const ids = new Set<number>();

		// ERP (exato). Se numérico, tenta por ID direto também.
		const erpRaw = (filters.customerErp ?? "").trim();
		if (erpRaw) {
			try {
				const { data } = await customersService.getCustomers({
					instance,
					COD_ERP: erpRaw,
					perPage: "1"
				} as any);
				(data || [])
					.map((c: any) => c?.CODIGO)
					.filter((x: any) => Number.isFinite(x))
					.forEach((id: number) => ids.add(id));
			} catch (err) {
				console.error("[searchCustomerIdsByFilters] erro ERP", err);
			}

			const erpDigits = erpRaw.replace(/\D/g, "");
			if (erpDigits) {
				try {
					const { data } = await customersService.getCustomers({
						instance,
						CODIGO: erpDigits,
						perPage: "1"
					} as any);
					(data || [])
						.map((c: any) => c?.CODIGO)
						.filter((x: any) => Number.isFinite(x))
						.forEach((id: number) => ids.add(id));
				} catch (_) {
					// ignora
				}
			}
		}

		// CPF/CNPJ (exato, dígitos)
		const cnpjDigits = (filters.customerCnpj ?? "").replace(/\D/g, "");
		if (cnpjDigits) {
			try {
				const { data } = await customersService.getCustomers({
					instance,
					CPF_CNPJ: cnpjDigits,
					perPage: "1"
				} as any);
				(data || [])
					.map((c: any) => c?.CODIGO)
					.filter((x: any) => Number.isFinite(x))
					.forEach((id: number) => ids.add(id));
			} catch (err) {
				console.error("[searchCustomerIdsByFilters] erro CPF_CNPJ", err);
			}
		}

		// Razão social (parcial) se ainda não achou nada: paginar até 5 páginas
		const name = (filters.customerName ?? "").trim();
		if (!ids.size && name) {
			for (let page = 1; page <= 5; page++) {
				const params = this.mapCustomerFilters(instance, filters, page);
				try {
					const response = await customersService.getCustomers(params as any);
					const customers: any[] = response?.data ?? [];
					customers
						.map((c: any) => c?.CODIGO)
						.filter((x: any) => Number.isFinite(x))
						.forEach((id: number) => ids.add(id));

					if (ids.size > 0) break;
				} catch (error) {
					console.error("[searchCustomerIdsByFilters] erro RAZAO", error);
					break;
				}
			}
		}

		return Array.from(ids);
	}


	private async getCustomersByIds(instance: string, customerIds: number[]): Promise<Map<number, Customer>> {
		const result = new Map<number, Customer>();

		const uniqueIds = Array.from(new Set(customerIds)).filter((id) => Number.isFinite(id));
		if (uniqueIds.length === 0) {
			return result;
		}

		const concurrency = 10;
		for (let i = 0; i < uniqueIds.length; i += concurrency) {
			const batch = uniqueIds.slice(i, i + concurrency);
			await Promise.all(
				batch.map(async (id) => {
					try {
						const resp = await customersService.getCustomers({
							instance,
							CODIGO: id.toString(),
							perPage: "1"
						} as any);
						const customer = (resp as any)?.data?.[0];
						if (customer?.CODIGO) {
							result.set(customer.CODIGO, customer);
						}
					} catch (error: any) {
						// Apenas loga outros erros e continua
						console.error(`Erro ao buscar cliente ${id}:`, error);
					}
				})
			);
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
			include: { sectors: true } as any
		});

		// If contact exists and mapped to a customer, keep old behavior
		if (
			existingContact &&
			!!existingContact.customerId &&
			existingContact.customerId !== -1 &&
			customerId
		) {
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
				customerId: null,
				isDeleted: true
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
