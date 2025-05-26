import { Prisma } from "@prisma/client";
import prismaService from "./prisma.service";
import whatsappService from "./whatsapp.service";
import customersService from "./customers.service";
import chatsService from "./chats.service";
import usersService from "./users.service";
import { User } from "@in.pulse-crm/sdk";

class ContactsService {
	public async getOrCreateContact(
		instance: string,
		name: string,
		phone: string
	) {
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

		const users = await usersService
			.getUsers({ perPage: "999" })
			.then((res) => {
				const users: Map<number, User> = new Map();

				res.data.forEach((user) => {
					users.set(user.CODIGO, user);
				});

				return users;
			});

		const contacts = await prismaService.wppContact.findMany({
			where: {
				instance
			}
		});

		customersService.setAuth(token);

		const res = await customersService.getCustomers({
			perPage: "999999"
		});

		return contacts.map((contact) => {
			const customer =
				contact.customerId &&
				res.data.find((c) => c.CODIGO === contact.customerId);
			const chat = chats.find((c) => c.contactId === contact.id);
			const user = chat
				? users.get(chat.userId || -200)?.NOME || "Supervisão"
				: null;

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
				customerId
			}
		});

		return contacts;
	}

	public async createContact(
		instance: string,
		name: string,
		phone: string,
		customerId: number
	) {
		const validPhone = await whatsappService.getValidWhatsappPhone(
			instance,
			phone
		);

		if (!validPhone) {
			throw new Error("Invalid phone number!");
		}

		const contact = await prismaService.wppContact.create({
			data: {
				instance,
				name,
				phone: validPhone,
				customerId
			}
		});

		return contact;
	}

	public async updateContact(
		contactId: number,
		data: Prisma.WppContactUpdateInput
	) {
		const contact = await prismaService.wppContact.update({
			where: {
				id: contactId
			},
			data
		});

		return contact;
	}

	public async deleteContact(contactId: number) {
		const contact = await prismaService.wppContact.delete({
			where: {
				id: contactId
			}
		});

		return contact;
	}
}

export default new ContactsService();
