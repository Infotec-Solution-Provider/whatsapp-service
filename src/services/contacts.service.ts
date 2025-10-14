import { User } from "@in.pulse-crm/sdk";
import { Prisma } from "@prisma/client";
import chatsService from "./chats.service";
import customersService from "./customers.service";
import prismaService from "./prisma.service";
import usersService from "./users.service";
import whatsappService from "./whatsapp.service";
import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";

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

		return await prismaService.wppContact.create({
			data: {
				instance,
				name,
				phone
			}
		});
	}

	public async getContactsWithCustomer(instance: string, token: string) {
		const chats = await chatsService.getChats({ isFinished: "false" });
		usersService;
		usersService.setAuth(token);

		const users = await usersService.getUsers({ perPage: "999" }).then((res) => {
			const users: Map<number, User> = new Map();

			res.data.forEach((user) => {
				users.set(user.CODIGO, user);
			});

			return users;
		});

		const contacts = await prismaService.wppContact.findMany({
			where: {
				instance,
				isDeleted: false
			}
		});

		customersService.setAuth(token);

		const res = await customersService.getCustomers({
			perPage: "999999"
		});

		return contacts.map((contact) => {
			const customer = contact.customerId && res.data.find((c) => c.CODIGO === contact.customerId);
			const chat = chats.find((c) => c.contactId === contact.id);
			const user = chat ? users.get(chat.userId || -200)?.NOME || "Supervisão" : null;

			return {
				...contact,
				customer: customer || null,
				chatingWith: user
			};
		});
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
		let contact;
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

		if (existingContact) {
			const message = `Este número já está cadastrado no cliente de código ${existingContact.customerId}`;
			throw new ConflictError(message);
		}

		const createdContact = await prismaService.wppContact.create({
			data: {
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
