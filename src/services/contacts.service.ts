import { tenantSqlEnabled } from "../tenant-sql/registry";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { SessionData } from "../sdk-local";
import { Prisma, WppContact } from "@prisma/client";
import { BadRequestError, ConflictError, InternalServerError, NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import { parseContactEdit, parseContactSectorIds } from "./contact-edit.contract";
import positiveResourceId from "../utils/positive-resource-id";
import { ContactMapper } from "../mappers/contact.mapper";
import { CustomerSchedule } from "../message-flow/base/base.step";
import { ContactQueryBuilder } from "../utils/contact-query-builder";
import { PaginationHelper } from "../utils/pagination-helper";
import { safeEncode } from "../utils/safe-encode";
import instancesService from "./instances.service";
import parametersService from "./parameters.service";
import prismaService from "./prisma.service";

export interface ContactsFilters {
	ids?: number[] | null;
	id?: number | null;
	name: string | null;
	phone: string | null;
	phones?: string[] | null;
	customerIds?: number[] | null;
	customerId: number | null;
	customerErp: string | null;
	customerCnpj: string | null;
	customerName: string | null;
	hasCustomer: boolean | null;
	sectorIds: number[] | null;
	purchaseStatus?: "with_purchases" | "without_purchases" | null;
	purchaseFrom?: string | null;
	purchaseTo?: string | null;
	campaignIds?: number[] | null;
	segmentIds?: number[] | null;
	registeredFrom?: string | null;
	registeredTo?: string | null;
	loyaltyOperatorIds?: number[] | null;
	page: number;
	perPage: number;
}

export class ContactAlreadyExistsError extends Error {
	constructor(
		public readonly contactId: number,
		public readonly isDeleted: boolean
	) {
		super("Este número já está cadastrado.");
		this.name = "ContactAlreadyExistsError";
	}
}

export class DeletedContactConflictError extends Error {
	public readonly isDeleted = true;

	constructor(public readonly contactId: number) {
		super("Este contato está desativado e precisa de aprovação para ser reativado.");
		this.name = "DeletedContactConflictError";
	}
}

class ContactsService {
	private normalizeDigits(value: string) {
		return value.replace(/\D/g, "");
	}

	private normalizePhone(phone?: string | null): string | null {
		if (!phone) {
			return null;
		}

		let normalized = this.normalizeDigits(phone);
		if (!normalized) {
			return null;
		}

		if (!normalized.startsWith("55")) {
			normalized = "55" + normalized;
		}

		return normalized;
	}

	private normalizeWhatsappId(whatsappId?: string | null): string | null {
		if (!whatsappId) {
			return null;
		}

		const normalized = whatsappId.trim().replace(/^me:/, "").split("@")[0] || "";
		return normalized || null;
	}

	private getPhoneAlternatives(phone: string): string[] {
		const hasExtraDigit = phone.length === 13;
		const alt = hasExtraDigit ? phone.slice(0, 4) + phone.slice(5) : phone.slice(0, 4) + "9" + phone.slice(4);
		return [...new Set([phone, alt])];
	}

	public resolveContactAddress(contact: Pick<WppContact, "phone" | "whatsappId">): string | null {
		return this.normalizeWhatsappId(contact.whatsappId) || this.normalizePhone(contact.phone);
	}

	private buildContactLookupWhere(instance: string, identifier: string): Prisma.WppContactWhereInput {
		const normalizedId = this.normalizeWhatsappId(identifier);
		const normalizedPhone = this.normalizePhone(identifier);
		const orFilters: Prisma.WppContactWhereInput[] = [];

		if (normalizedId) {
			orFilters.push({ whatsappId: normalizedId });
		}

		if (normalizedPhone) {
			for (const phone of this.getPhoneAlternatives(normalizedPhone)) {
				orFilters.push({ phone });
			}
		}

		if (orFilters.length === 0) {
			return { instance, id: -1 };
		}

		return { instance, OR: orFilters };
	}

	public async findContactByAddress(instance: string, identifier: string) {
		return prismaService.wppContact.findFirst({
			where: this.buildContactLookupWhere(instance, identifier)
		});
	}

	public async getOrCreateContact(instance: string, name: string, phone?: string | null, whatsappId?: string | null) {
		const normalizedPhone = this.normalizePhone(phone);
		const normalizedWhatsappId = this.normalizeWhatsappId(whatsappId ?? phone) ?? normalizedPhone;

		if (!normalizedPhone && !normalizedWhatsappId) {
			throw new BadRequestError("Não foi possível identificar o contato sem telefone ou whatsappId.");
		}

		// The whatsappId is the strongest identity. Resolve it first so a contact
		// found by phone cannot accidentally claim an id owned by another row.
		const contactByWhatsappId = normalizedWhatsappId
			? await prismaService.wppContact.findFirst({
					where: { instance, whatsappId: normalizedWhatsappId }
				})
			: null;

		const whereFilters: Prisma.WppContactWhereInput[] = [];
		if (normalizedWhatsappId) {
			whereFilters.push({ whatsappId: normalizedWhatsappId });
		}
		if (normalizedPhone) {
			for (const altPhone of this.getPhoneAlternatives(normalizedPhone)) {
				whereFilters.push({ phone: altPhone });
			}
		}

		const contact =
			contactByWhatsappId ??
			(await prismaService.wppContact.findFirst({
				where: {
					instance,
					OR: whereFilters
				}
			}));

		if (contact) {
			const updateData: Prisma.WppContactUpdateInput = {};

			if (!contact.whatsappId && normalizedWhatsappId) {
				updateData.whatsappId = normalizedWhatsappId;
			}

			if (!contact.phone && normalizedPhone) {
				const contactWithPhone = await prismaService.wppContact.findFirst({
					where: {
						instance,
						phone: { in: this.getPhoneAlternatives(normalizedPhone) },
						NOT: { id: contact.id }
					}
				});
				if (!contactWithPhone) {
					updateData.phone = normalizedPhone;
				}
			}

			if (contact.whatsappId === normalizedWhatsappId) {
				delete updateData.whatsappId;
			}

			if (Object.keys(updateData).length > 0) {
				try {
					const updated = await prismaService.wppContact.update({
						where: { id: contact.id },
						data: updateData
					});
					await this.syncContactToLocal(updated);
					return updated;
				} catch (error) {
					if (
						error instanceof Prisma.PrismaClientKnownRequestError &&
						error.code === "P2002" &&
						normalizedWhatsappId
					) {
						const owner = await prismaService.wppContact.findFirst({
							where: { instance, whatsappId: normalizedWhatsappId }
						});
						if (owner) {
							return owner;
						}
					}
					throw error;
				}
			}

			return contact;
		}

		let newContact: WppContact;
		try {
			newContact = await prismaService.wppContact.create({
				data: {
					instance,
					name,
					phone: normalizedPhone,
					whatsappId: normalizedWhatsappId!
				}
			});
		} catch (error) {
			// Another request may have created the same contact between the lookup
			// and create. Re-read the unique owner and continue idempotently.
			if (
				error instanceof Prisma.PrismaClientKnownRequestError &&
				error.code === "P2002" &&
				normalizedWhatsappId
			) {
				const concurrentContact = await prismaService.wppContact.findFirst({
					where: { instance, whatsappId: normalizedWhatsappId }
				});
				if (concurrentContact) {
					return concurrentContact;
				}
			}
			throw error;
		}

		await this.syncContactToLocal(newContact);

		return newContact;
	}

	public async getContactsWithCustomerLocally(instance: string, filters: ContactsFilters) {
		const execute = <T>(sql: string, params: any[]): Promise<T> => tenantSqlEnabled()
			? withDatabaseTenant(instance, () => prismaService.$queryRawUnsafe<T>(sql
				.replace(/\bwpp_contacts\b/g, "contacts").replace(/\bwpp_chats\b/g, "chats")
				.replace(/\bwpp_contact_sectors\b/g, "(SELECT contactId AS contact_id, sectorId AS sector_id FROM contacts_sectors)"), ...params))
			: instancesService.executeQuery<T>(instance, sql, params);
		// Validate and normalize pagination parameters
		const { page, perPage } = PaginationHelper.validatePagination(filters.page, filters.perPage);

		// Build WHERE conditions and parameters
		const { conditions, params } = ContactQueryBuilder.buildWhereConditions(filters);
		const whereClause = conditions.join(" AND ");

		// Execute count query
		const countQuery = ContactQueryBuilder.buildCountQuery(whereClause);
		const countResult = await execute<Array<{ total: number }>>(countQuery, params);

		const total = countResult[0]?.total || 0;

		// Early return if no results
		if (total === 0) {
			return {
				data: [],
				pagination: PaginationHelper.buildEmptyResponse(page, perPage)
			};
		}

		// Execute data query with pagination
		const dataQuery = ContactQueryBuilder.buildDataQuery(whereClause);
		const offset = PaginationHelper.calculateOffset(page, perPage);
		const dataQueryParams = [...params, perPage, offset];

		const contacts = await execute<any[]>(dataQuery, dataQueryParams);

		// Early return if query returned no results (shouldn't happen but safety check)
		if (contacts.length === 0) {
			return {
				data: [],
				pagination: PaginationHelper.buildEmptyResponse(page, perPage)
			};
		}

		// Map database rows to contact objects
		const mappedContacts = contacts.map((row) => ContactMapper.mapDatabaseRow(row, !tenantSqlEnabled()));

		return {
			data: mappedContacts,
			pagination: PaginationHelper.buildPaginationResponse(page, perPage, total)
		};
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

	public async createContact(
		instance: string,
		name: string,
		phone: string,
		customerId?: number,
		sectorIds?: number[],
		overwriteExisting = false
	) {
		sectorIds = parseContactSectorIds(sectorIds);
		if (sectorIds !== undefined) await this.validateContactSectors(prismaService, instance, sectorIds);
		const validPhone = this.normalizePhone(phone);
		if (!validPhone) {
			throw new BadRequestError("Informe o telefone do contato.");
		}
		const phones = this.getPhoneAlternatives(validPhone);
		const findExistingContact = async () => {
			// Prefer the registered phone when legacy records have conflicting identities.
			const byPhone = await prismaService.wppContact.findFirst({
				where: { instance, phone: { in: phones } },
				include: { sectors: true }
			});
			return byPhone ?? prismaService.wppContact.findFirst({
				where: { instance, whatsappId: { in: phones } },
				include: { sectors: true }
			});
		};
		const existingContact = await findExistingContact();

		if (existingContact) {
			return this.reuseContactForRegistration(existingContact, name, customerId, sectorIds, overwriteExisting);
		}

		// Contact does not exist: create new and optionally link sectors
		const createData: any = {
			instance,
			name,
			phone: validPhone,
			whatsappId: validPhone,
			customerId: customerId || null
		};

		if (sectorIds && sectorIds.length > 0) {
			// create nested rows in the join table
			createData.sectors = {
				create: sectorIds.map((id) => ({ sectorId: id }))
			};
		}

		let createdContact;
		try {
			createdContact = await prismaService.wppContact.create({
				data: createData,
				include: { sectors: true }
			});
		} catch (error) {
			if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
				const concurrentContact = await findExistingContact();
				if (concurrentContact) {
					// A concurrently created record has not been reviewed for overwriting.
					return this.reuseContactForRegistration(concurrentContact, name, customerId, sectorIds, false);
				}
			}
			throw error;
		}

		await this.syncContactToLocal(createdContact);
		if (sectorIds && sectorIds.length > 0) {
			await this.syncContactSectorsToLocal(createdContact.id, instance, sectorIds);
		}

		return createdContact;
	}

	private async reuseContactForRegistration(
		contact: WppContact & { sectors: Array<{ sectorId: number }> },
		name: string,
		customerId: number | undefined,
		sectorIds: number[] | undefined,
		overwriteExisting: boolean
	) {
		const requestedSectors = [...new Set(sectorIds ?? [])];
		const preservesSectors = sectorIds === undefined || (
			requestedSectors.length === contact.sectors.length &&
			contact.sectors.every(({ sectorId }) => requestedSectors.includes(sectorId))
		);
		const hasNoCustomer = contact.customerId === null || contact.customerId === 0 || contact.customerId === -1;
		const canLinkCustomer = !contact.isDeleted && hasNoCustomer &&
			customerId !== undefined && Number.isInteger(customerId) && customerId > 0 && preservesSectors;

		if (!overwriteExisting && !canLinkCustomer) {
			throw new ContactAlreadyExistsError(contact.id, contact.isDeleted);
		}
		if (contact.isDeleted) {
			throw new DeletedContactConflictError(contact.id);
		}

		let updated;
		try {
			updated = await prismaService.wppContact.update({
				where: {
					id: contact.id,
					instance: contact.instance,
					isDeleted: false,
					...(!overwriteExisting ? { customerId: contact.customerId } : {})
				},
				data: {
					name,
					customerId: customerId ?? null,
					...(overwriteExisting ? {
						sectors: {
							deleteMany: {},
							create: requestedSectors.map((sectorId) => ({ sectorId }))
						}
					} : {})
				},
				include: { sectors: true }
			});
		} catch (error) {
			if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
				const current = await prismaService.wppContact.findFirst({
					where: { id: contact.id, instance: contact.instance }
				});
				if (current) {
					throw new ContactAlreadyExistsError(current.id, current.isDeleted);
				}
			}
			throw error;
		}

		await this.syncContactToLocal(updated);
		if (overwriteExisting) {
			await this.syncContactSectorsToLocal(updated.id, contact.instance, requestedSectors);
		}
		return updated;
	}

	public async updateContactWrapper(
		session: SessionData,
		contactId: number,
		input: unknown,
		rawSectorIds?: unknown
	) {
		positiveResourceId(contactId);
		const data = parseContactEdit(input);
		const sectorIds = parseContactSectorIds(rawSectorIds);
		const existing = await this.editableContact(session, contactId);
		const customerId = existing.customerId && existing.customerId > 0 ? existing.customerId : null;
		if (data.customerId !== undefined && data.customerId !== customerId) {
			throw new ConflictError("O vínculo do cliente deve ser alterado pela operação específica. Atualize o contato.");
		}
		const contact = await prismaService.$transaction(async tx => {
			if (sectorIds !== undefined) await this.validateContactSectors(tx, session.instance, sectorIds);
			return tx.wppContact.update({
				where: { id: contactId, instance: session.instance, isDeleted: false, customerId: existing.customerId,
					...(session.role === "ADMIN" ? {} : { isOnlyAdmin: false }) },
				data: {
					...(data.name === undefined ? {} : { name: data.name }),
					...(sectorIds === undefined ? {} : { sectors: { deleteMany: {}, create: sectorIds.map(sectorId => ({ sectorId })) } })
				},
				include: { sectors: true }
			});
		});
		await this.syncContactToLocal(contact);
		if (sectorIds !== undefined) await this.syncContactSectorsToLocal(contactId, session.instance, sectorIds);
		return contact;
	}

	private async editableContact(session: SessionData, contactId: number) {
		const contact = await prismaService.wppContact.findFirst({
			where: { id: contactId, instance: session.instance, isDeleted: false }, include: { sectors: true }
		});
		if (!contact) throw new NotFoundError("Contato ativo não encontrado.");
		if (session.role !== "ADMIN") {
			if (contact.isOnlyAdmin) throw new UnauthorizedError("Contato restrito a administradores.");
			const parameters = await parametersService.getSessionParams(session);
			if (parameters["update_only_own_contacts"] === "true" && contact.customerId) {
				const loyalty = await this.getContactLoalty(contact);
				if (!loyalty || loyalty.userId !== session.userId) throw new UnauthorizedError("Você só pode atualizar contatos fidelizados com você.");
			}
		}
		return contact;
	}

	private async validateContactSectors(tx: Prisma.TransactionClient, instance: string, sectorIds: number[]) {
		if (!sectorIds.length) return;
		const sectors = await tx.wppSector.findMany({ where: { instance, id: { in: sectorIds } }, select: { id: true } });
		if (sectors.length !== sectorIds.length) throw new BadRequestError("Um dos setores não está disponível nesta empresa.");
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

	public async addSectorToContact(session: SessionData, contactId: number, rawSectorId: unknown) {
		positiveResourceId(contactId);
		const sectorId = positiveResourceId(rawSectorId);
		const contact = await this.editableContact(session, contactId);
		if (!contact.sectors.length) throw new ConflictError("Este número já está cadastrado globalmente");
		const updated = await prismaService.$transaction(async tx => {
			await this.validateContactSectors(tx, session.instance, [sectorId]);
			return tx.wppContact.update({
				where: { id: contactId, instance: session.instance, isDeleted: false, customerId: contact.customerId,
					...(session.role === "ADMIN" ? {} : { isOnlyAdmin: false }) },
				data: { sectors: { connectOrCreate: { where: { contactId_sectorId: { contactId, sectorId } }, create: { sectorId } } } },
				include: { sectors: true }
			});
		});
		await this.syncContactToLocal(updated);
		await this.syncContactSectorsToLocal(contactId, session.instance, updated.sectors.map(sector => sector.sectorId));
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

		await this.syncContactToLocal(contact);

		return contact;
	}

	public async getDeletedContacts(instance: string, page: number, perPage: number) {
		const safePage = Number.isInteger(page) && page > 0 ? page : 1;
		const safePerPage = Number.isInteger(perPage) && perPage > 0 ? Math.min(100, perPage) : 20;
		const where = { instance, isDeleted: true };
		const [contacts, total] = await prismaService.$transaction([
			prismaService.wppContact.findMany({
				where,
				include: { sectors: true } as any,
				orderBy: { updatedAt: "desc" },
				skip: (safePage - 1) * safePerPage,
				take: safePerPage
			}),
			prismaService.wppContact.count({ where })
		]);

		return {
			contacts,
			pagination: {
				page: safePage,
				perPage: safePerPage,
				total,
				totalPages: Math.ceil(total / safePerPage)
			}
		};
	}

	public async reactivateContact(instance: string, contactId: number) {
		const existing = await prismaService.wppContact.findFirst({
			where: { id: contactId, instance },
			include: { sectors: true } as any
		});
		if (!existing) {
			throw new BadRequestError("Contato não encontrado.");
		}

		const contact = existing.isDeleted
			? await prismaService.wppContact.update({
					where: { id: contactId },
					data: { isDeleted: false },
					include: { sectors: true } as any
				})
			: existing;

		await this.syncContactToLocal(contact);
		return contact;
	}

	public async syncContactStateToLocal(contact: WppContact, sectorIds?: number[], requireSync = false) {
		await this.syncContactToLocal(contact, requireSync);
		if (sectorIds) {
			await this.syncContactSectorsToLocal(contact.id, contact.instance, sectorIds);
		}
	}

	private async syncContactToLocal(contact: WppContact, requireSync = false) {
        if (tenantSqlEnabled()) return;
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

			await instancesService.executeQuery(contact.instance, query, [
				contact.id,
				contact.instance,
				safeEncode(contact.name) || "",
				contact.phone,
				contact.customerId,
				contact.isDeleted
			]);
		} catch (error) {
			console.error("[syncContactToLocal] Erro ao sincronizar contato:", error);
			if (requireSync) throw new InternalServerError("CONTACT_CUSTOMER_SYNC_PENDING");
		}
	}

	private async syncContactSectorsToLocal(contactId: number, instance: string, sectorIds: number[]) {
        if (tenantSqlEnabled()) return;
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
