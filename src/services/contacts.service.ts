import { Customer, User } from "@in.pulse-crm/sdk";
import { Prisma } from "@prisma/client";
import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";
import chatsService from "./chats.service";
import customersService from "./customers.service";
import prismaService from "./prisma.service";
import usersService from "./users.service";
import whatsappService from "./whatsapp.service";

export interface ContactsFilters {
	name: string | null;
	phone: string | null;
	customerId: number | null;
	customerErp: string | null;
	customerCnpj: string | null;
	customerName: string | null;
	page: number;
	perPage: number;
}
interface InstanceCache {
	isRenewing: boolean;
	expiresAt: Date;
	customers: Map<number, Customer>;
	users: Map<number, User>;
}
class ContactsService {
	private cache: Map<string, InstanceCache> = new Map();
	private ongoingCacheRenewals: Map<string, Promise<InstanceCache>> = new Map();

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

	public async getContactsWithCustomer(instance: string, token: string) {
		customersService.setAuth(token);
		usersService.setAuth(token);

		const chatsPromise = chatsService.getChats({ isFinished: "false" });
		const contactsPromise = prismaService.wppContact.findMany({
			where: {
				instance,
				isDeleted: false
			}
		});

		const [chats, contacts, cache] = await Promise.all([chatsPromise, contactsPromise, this.getInstanceCache(instance)]);

		return contacts.map((contact) => {
			const customer = contact.customerId && cache.customers.get(contact.customerId);
			const chat = chats.find((c) => c.contactId === contact.id);

			// Gambiarra
			const user = chat ? cache.users.get(chat.userId || -200)?.NOME || "Supervisão" : null;

			return {
				...contact,
				customer: customer || null,
				chatingWith: user
			};
		});
	}
	private getInstanceCache(instance: string) {
		const cached = this.cache.get(instance);
		const isValid = cached && cached.expiresAt > new Date();
		const renewing = this.ongoingCacheRenewals.get(instance);

		if (!cached || (!isValid && !renewing)) {
			// Mark as renewing if cache exists
			if (cached) {
				cached.isRenewing = true;
			}
			const newCachePromise = this.renewCache(instance);
			this.ongoingCacheRenewals.set(instance, newCachePromise);
			return newCachePromise;
		} else if (cached && renewing) {
			return renewing;
		}

		return Promise.resolve(cached);
	}

	private async renewCache(instance: string) {
		try {
			const existingCache = this.cache.get(instance);
			// Mark as renewing if cache exists
			if (existingCache) {
				existingCache.isRenewing = true;
			}
			const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutos

			const users = await usersService.getUsers({ perPage: "999" }).then(({ data }) => {
				const users: Map<number, User> = new Map();
				data.forEach((user) => users.set(user.CODIGO, user));
				return users;
			});

			const customers = await customersService.getCustomers({ perPage: "99999" }).then(({ data }) => {
				const customers: Map<number, Customer> = new Map();
				data.forEach((c) => customers.set(c.CODIGO, c));
				return customers;
			});
			
			const newCache: InstanceCache = { expiresAt, customers, users, isRenewing: false };
			this.cache.set(instance, newCache);
			
			// Clean up ongoing renewal tracking
			this.ongoingCacheRenewals.delete(instance);
			
			return newCache;
		} catch (error) {
			// Clean up ongoing renewal tracking on error
			this.ongoingCacheRenewals.delete(instance);
			throw error;
		}
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

	public async createContact(instance: string, name: string, phone: string, customerId?: number) {
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
			}
		});

		if (existingContact && !!existingContact.customerId) {
			const message = `Este número já está cadastrado no cliente de código ${existingContact.customerId}`;
			throw new ConflictError(message);
		}

		const createdContact = await prismaService.wppContact.upsert({
			where: {
				instance_phone: {
					instance,
					phone: validPhone
				}
			},
			update: {
				name,
				customerId: customerId || null
			},
			create: {
				instance,
				name,
				phone: validPhone,
				customerId: customerId || null
			}
		});

		return createdContact;
	}

	public async updateContact(contactId: number, data: Prisma.WppContactUpdateInput) {
		const contact = await prismaService.wppContact.update({
			where: {
				id: contactId
			},
			data
		});

		return contact;
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
