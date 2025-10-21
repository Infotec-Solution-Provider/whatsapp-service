import { Customer, User } from "@in.pulse-crm/sdk";
import { Prisma } from "@prisma/client";
import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";
import chatsService from "./chats.service";
import customersService from "./customers.service";
import prismaService from "./prisma.service";
import usersService from "./users.service";
import whatsappService from "./whatsapp.service";
import redisService from "./redis.service";

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

		const [chats, contacts] = await Promise.all([chatsPromise, contactsPromise]);

		// Coletar IDs únicos de clientes e usuários necessários
		const uniqueCustomerIds = [...new Set(contacts.map(c => c.customerId).filter(Boolean))] as number[];
		const uniqueUserIds = [...new Set(chats.map(c => c.userId).filter(Boolean))] as number[];

		// Buscar dados do cache (Redis) ou da API
		const [customersMap, usersMap] = await Promise.all([
			this.getCustomersByIds(instance, uniqueCustomerIds),
			this.getUsersByIds(instance, uniqueUserIds)
		]);

		return contacts.map((contact) => {
			const customer = contact.customerId && customersMap.get(contact.customerId);
			const chat = chats.find((c) => c.contactId === contact.id);

			// Gambiarra
			const user = chat ? usersMap.get(chat.userId || -200)?.NOME || "Supervisão" : null;

			return {
				...contact,
				customer: customer || null,
				chatingWith: user
			};
		});
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
		const cacheKeys = customerIds.map(id => `customer:${instance}:${id}`);
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
				const requestedCustomers = customers.filter(c => batch.includes(c.CODIGO));

				// Armazenar no Redis e no resultado
				const cacheItems = requestedCustomers.map(customer => ({
					key: `customer:${instance}:${customer.CODIGO}`,
					value: customer,
					ttl: this.CUSTOMER_CACHE_TTL
				}));

				await redisService.mset(cacheItems);

				requestedCustomers.forEach(customer => {
					result.set(customer.CODIGO, customer);
				});
			}
		} catch (error) {
			console.error('Erro ao buscar clientes:', error);
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
		const cacheKeys = userIds.map(id => `user:${instance}:${id}`);
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
				const requestedUsers = users.filter(u => batch.includes(u.CODIGO));

				// Armazenar no Redis e no resultado
				const cacheItems = requestedUsers.map(user => ({
					key: `user:${instance}:${user.CODIGO}`,
					value: user,
					ttl: this.USER_CACHE_TTL
				}));

				await redisService.mset(cacheItems);

				requestedUsers.forEach(user => {
					result.set(user.CODIGO, user);
				});
			}
		} catch (error) {
			console.error('Erro ao buscar usuários:', error);
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
