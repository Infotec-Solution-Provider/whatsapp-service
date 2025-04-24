import { Prisma, WppChat, WppContact, WppMessage } from "@prisma/client";
import prismaService from "./prisma.service";
import { Customer, SessionData, SocketEventType } from "@in.pulse-crm/sdk";
import customersService from "./customers.service";
import instancesService from "./instances.service";
import socketService from "./socket.service";
import messagesDistributionService from "./messages-distribution.service";
import usersService from "./users.service";

interface InpulseResult {
	NOME: string;
}

interface ChatsFilters {
	userId?: string;
	isFinished?: string;
}

const FETCH_CUSTOMERS_QUERY = "SELECT * FROM clientes WHERE CODIGO IN (?)";
const FETCH_RESULT_QUERY = "SELECT * FROM resultados WHERE CODIGO = ?";

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
				isFinished: false,
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
				contact: {
					include: {
						WppMessage: true
					}
				}
			}
		});

		if (session.role === "ADMIN") {
			const foundAdminChats = await prismaService.wppChat.findMany({
				where: {
					userId: -1,
					sectorId: session.sectorId,
					isFinished: false
				},
				include: {
					contact: {
						include: {
							WppMessage: true
						}
					}
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
			const { contact, ...chat } = foundChat;

			let customer: Customer | null = null;

			if (includeContact && typeof contact?.customerId == "number") {
				customer =
					customers.find((c) => c.CODIGO === contact.customerId) ||
					null;
			}

			chats.push({ ...chat, customer, contact: contact || null });

			if (includeMessages && contact) {
				messages.push(...contact.WppMessage);
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
			try {
				const customer = await customersService.getCustomerById(
					chat.contact.customerId
				);

				return { ...chat, customer };
			} catch (err) {
				return chat;
			}
		}

		return chat;
	}

	public async finishChatById(
		token: string,
		session: SessionData,
		id: number,
		resultId: number
	) {
		const results = await instancesService.executeQuery<InpulseResult[]>(
			session.instance,
			FETCH_RESULT_QUERY,
			[resultId]
		);
		const { instance, userId } = session;
		usersService.setAuth(token);

		console.log(session, id, resultId);
		const user = await usersService.getUserById(userId);
		const chat = await prismaService.wppChat.update({
			where: { id },
			data: {
				isFinished: true,
				finishedAt: new Date(),
				finishedBy: userId,
				resultId
			}
		});
		const event = SocketEventType.WppChatFinished;
		const finishMsg = `Atendimento finalizado por ${user.NOME}.\nResultado: ${results[0]?.NOME || "N/D"} `;
		await messagesDistributionService.addSystemMessage(chat, finishMsg);
		await socketService.emit(event, `${instance}:chat:${chat.id}`, {
			chatId: chat.id
		});
	}
}

export default new ChatsService();
