import { Prisma, WppChat, WppContact, WppMessage } from "@prisma/client";
import prismaService from "./prisma.service";
import { Customer, SessionData } from "@in.pulse-crm/sdk";
import customersService from "./customers.service";
import instancesService from "./instances.service";

interface ChatsFilters {
	userId?: string;
	isFinished?: string;
}

const FETCH_CUSTOMERS_QUERY = "SELECT * FROM clientes WHERE CODIGO IN (?)";

class ChatsService {
	public async getChatForContact(
		sectorId: number,
		contact: WppContact
	): Promise<WppChat | null> {
		return await prismaService.wppChat.findFirst({
			where: {
				contactId: contact.id,
				sectorId: sectorId,
				isFinished: false
			}
		});
	}

	public async getUserChatsBySession(
		session: SessionData,
		includeMessages = true,
		includeContact = true
	) {
		const foundChats = await prismaService.wppChat.findMany({
			where: {
				OR: [
					{
						userId: session.userId
					},
					{
						wallet: {
							WppWalletUser: {
								some: {
									userId: session.userId
								}
							}
						}
					}
				]
			},
			include: {
				messages: includeMessages,
				contact: includeContact
			}
		});

		if (session.role === "ADMIN") {
			const foundAdminChats = await prismaService.wppChat.findMany({
				where: {
					userId: -1,
					sectorId: session.sectorId
				},
				include: {
					messages: includeMessages,
					contact: includeContact
				}
			});

			foundChats.push(...foundAdminChats);
		}

		const chats: Array<
			WppChat & { customer: Customer | null; contact: WppContact | null }
		> = [];
		const messages: Array<WppMessage> = [];
		const customerIds = includeContact
			? foundChats
					.filter(
						(chat) => typeof chat.contact?.customerId === "number"
					)
					.map((c) => c.contact!.customerId!)
			: [];

		const customers = customerIds.length
			? await instancesService.executeQuery<Array<Customer>>(
					session.instance,
					FETCH_CUSTOMERS_QUERY,
					[
						foundChats
							.filter(
								(chat) =>
									typeof chat.contact?.customerId === "number"
							)
							.map((c) => c.contact!.customerId!)
					]
				)
			: [];

		for (const foundChat of foundChats) {
			const { messages: msgs, contact, ...chat } = foundChat;

			let customer: Customer | null = null;

			if (includeContact && typeof contact?.customerId == "number") {
				customer =
					customers.find((c) => c.CODIGO === contact.customerId) ||
					null;
			}

			chats.push({ ...chat, customer, contact: contact || null });

			if (includeMessages) {
				messages.push(...msgs);
			}
		}

		return { chats, messages };
	}

	public async getChats(filters: ChatsFilters) {
		const whereClause: Prisma.WppChatWhereInput = {};

		if (filters.userId) {
			whereClause.userId = +filters.userId;
		}

		if (filters.isFinished) {
			whereClause.isFinished =
				filters.isFinished === "true" ? true : false;
		}

		const chats = await prismaService.wppChat.findMany({
			include: {
				messages: true,
				contact: true
			},
			where: whereClause
		});

		return chats;
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
