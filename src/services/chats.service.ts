import { WppChat, WppContact, WppMessage } from "@prisma/client";
import prismaService from "./prisma.service";
import { Customer, SessionData } from "@in.pulse-crm/sdk";
import customersService from "./customers.service";
import instancesService from "./instances.service";

const FETCH_CUSTOMERS_QUERY = "SELECT * FROM clientes WHERE CODIGO IN (?)";

class ChatsService {
	public async getChatForContact(
		sectorId: number,
		contact: WppContact
	): Promise<WppChat | null> {
		return await prismaService.wppChat.findFirst({
			where: {
				contactId: contact.id,
				sectorId: sectorId
			}
		});
	}

	public async getUserChats(session: SessionData) {
		const foundChats = await prismaService.wppChat.findMany({
			where: {
				userId: session.userId,
				wallet: {
					WppWalletUser: {
						some: {
							userId: session.userId
						}
					}
				}
			},
			include: {
				messages: true,
				contact: true
			}
		});

		if (session.role === "ADMIN") {
			const foundAdminChats = await prismaService.wppChat.findMany({
				where: {
					userId: -1,
					sectorId: session.sectorId
				},
				include: {
					messages: true,
					contact: true
				}
			});

			foundChats.push(...foundAdminChats);
		}

		const chats: Array<WppChat & { customer: Customer | null }> = [];
		const messages: Array<WppMessage> = [];
		const customers = await instancesService.executeQuery<Array<Customer>>(
			session.instance,
			FETCH_CUSTOMERS_QUERY,
			foundChats
				.filter((chat) => typeof chat.contact?.customerId === "number")
				.map((c) => c.contact!.customerId!)
		);

		for (const foundChat of foundChats) {
			const { messages: msgs, contact, ...chat } = foundChat;

			if (contact?.customerId) {
				const customer =
					customers.find((c) => c.CODIGO === contact.customerId) ||
					null;
				chats.push({ ...chat, customer });
			}

			messages.push(...msgs);
		}

		return { chats, messages };
	}

	public async getChatById(id: number) {
		const chat = await prismaService.wppChat.findUnique({
			where: { id },
			include: {
				messages: true,
				contact: true
			}
		});

		if (chat?.contact?.customerId) {
			const customer = await customersService.getCustomerById(
				chat.contact.customerId
			);
			return { ...chat, customer };
		}

		return chat;
	}
}

export default new ChatsService();
