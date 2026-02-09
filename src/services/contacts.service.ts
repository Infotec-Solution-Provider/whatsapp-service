import { SessionData } from "@in.pulse-crm/sdk";
import { Prisma, WppContact } from "@prisma/client";
import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";
import { ContactMapper } from "../mappers/contact.mapper";
import { CustomerSchedule } from "../message-flow/base/base.step";
import { ContactQueryBuilder } from "../utils/contact-query-builder";
import { PaginationHelper } from "../utils/pagination-helper";
import { safeEncode } from "../utils/safe-encode";
import instancesService from "./instances.service";
import parametersService from "./parameters.service";
import prismaService from "./prisma.service";

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
		const hasDDI = phone.startsWith("55");
		if (!hasDDI) phone = "55" + phone;

		const hasExtraDigit = phone.length === 13;
		const phoneAlt = hasExtraDigit ? phone.slice(0, 4) + phone.slice(5) : phone.slice(0, 4) + "9" + phone.slice(4);

		const contact = await prismaService.wppContact.findFirst({
			where: {
				instance,
				OR: [
					{ phone },
					{ phone: phoneAlt }
				]
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

	public async getContactsWithCustomerLocally(instance: string, filters: ContactsFilters) {
		// Validate and normalize pagination parameters
		const { page, perPage } = PaginationHelper.validatePagination(filters.page, filters.perPage);

		// Build WHERE conditions and parameters
		const { conditions, params } = ContactQueryBuilder.buildWhereConditions(filters);
		const whereClause = conditions.join(" AND ");

		// Execute count query
		const countQuery = ContactQueryBuilder.buildCountQuery(whereClause);
		const countResult = await instancesService.executeQuery<Array<{ total: number }>>(
			instance,
			countQuery,
			params
		);

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

		const contacts = await instancesService.executeQuery<any[]>(instance, dataQuery, dataQueryParams);

		// Early return if query returned no results (shouldn't happen but safety check)
		if (contacts.length === 0) {
			return {
				data: [],
				pagination: PaginationHelper.buildEmptyResponse(page, perPage)
			};
		}

		// Map database rows to contact objects
		const mappedContacts = contacts.map((row) => ContactMapper.mapDatabaseRow(row));

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
		sectorIds?: number[]
	) {
		const hasDDI = phone.startsWith("55");
		const validPhone = hasDDI ? phone : "55" + phone;
		const hasExtraDigit = validPhone.length === 13;
		const validPhoneAlt = hasExtraDigit ? validPhone.slice(0, 4) + validPhone.slice(5) : validPhone.slice(0, 4) + "9" + validPhone.slice(4);

		const existingContact = await prismaService.wppContact.findFirst({
			where: {
				instance,
				OR: [
					{ phone: validPhone },
					{ phone: validPhoneAlt }
				]
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

	public async updateContact(contactId: number, data: Prisma.WppContactUpdateInput, sectorIds?: number[]) {
		if (!sectorIds) {
			const contact = await prismaService.wppContact.update({
				where: { id: contactId },
				data
			});

			await this.syncContactToLocal(contact);

			return contact;
		}

		const cleanedSectorIds = [...new Set(sectorIds)];

		const updatePayload: Prisma.WppContactUpdateInput = {
			...data,
			sectors: {
				deleteMany: {},
				create: cleanedSectorIds.map((id) => ({ sectorId: id }))
			}
		} as any;

		const contact = await prismaService.wppContact.update({
			where: { id: contactId },
			data: updatePayload,
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
				[contact.id, contact.instance, safeEncode(contact.name), contact.phone, contact.customerId, contact.isDeleted]
			);
		} catch (error) {
			console.error("[syncContactToLocal] Erro ao sincronizar contato:", error);
		}
	}

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
