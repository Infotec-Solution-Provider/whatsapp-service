import { Prisma, WppChat, WppContact, WppMessage } from "@prisma/client";
import prismaService from "./prisma.service";
import { Customer, SessionData, SocketEventType } from "@in.pulse-crm/sdk";
import customersService from "./customers.service";
import instancesService from "./instances.service";
import socketService from "./socket.service";
import messagesDistributionService from "./messages-distribution.service";
import usersService from "./users.service";
import whatsappService from "./whatsapp.service";
import ProcessingLogger from "../utils/processing-logger";

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
		clientId: number,
		contact: WppContact
	): Promise<WppChat | null> {
		return await prismaService.wppChat.findFirst({
			where: {
				contactId: contact.id,
				isFinished: false,
				sector: {
					WppInstance: {
						id: clientId
					}
				}
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
				instance: session.instance,
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
					isFinished: false,
					sectorId: session.sectorId,
					userId: -1
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
	public async getChatsMonitor(
		session: SessionData,
		includeMessages = true,
		includeContact = true
	) {
		const isTI = session.sectorId === 3;
		const foundChats = await prismaService.wppChat.findMany({
			where: {
				isFinished: false,
				instance: session.instance,
				...(isTI ? {} : { sectorId: session.sectorId })

			},
			include: {
				contact: {
					include: {
						WppMessage: true
					}
				},

			}
		});


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
			let userName = "";
			if (foundChat.userId) {
			const user = await usersService.getUserById(foundChat.userId);
				userName = user?.NOME || "";
			}
			chats.push({ ...chat, customer, contact: contact || null, userName });

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
	public async transferAttendance(
		token: string,
		session: SessionData,
		id: number,
		userId: number
	) {
		const { instance } = session;
		usersService.setAuth(token);

		const chats = await prismaService.wppChat.findUnique({
			where: { id }
		});
		if (!chats) {
			throw new Error("Chat não encontrado!");
		}
		if (!chats.userId) {
			throw new Error("Chat não possui userId!");
		}
		const user = await usersService.getUserById(chats.userId);

		const chat = await prismaService.wppChat.update({
			where: { id },
			data: {
				userId
			}
		});
		const event = SocketEventType.WppChatFinished;
		const transferMsg = `Atendimento tranferido por ${user.NOME}.`;
		await messagesDistributionService.addSystemMessage(chat, transferMsg);
		await socketService.emit(event, `${instance}:chat:${chat.id}`, {
			chatId: chat.id
		});
	}

	public async finishChatById(
		token: string | null,
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
		usersService.setAuth(token || "");

		const user =
			resultId !== -50 && (await usersService.getUserById(userId));
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

		let finishMsg: string = "";

		if (!user && resultId === -50) {
			finishMsg = `Atendimento finalizado pelo sistema.`;
		}
		if (user) {
			finishMsg = `Atendimento finalizado por ${user.NOME}.\nResultado: ${results[0]?.NOME || "N/D"} `;
		}

		await messagesDistributionService.addSystemMessage(chat, finishMsg);
		await socketService.emit(event, `${instance}:chat:${chat.id}`, {
			chatId: chat.id
		});
	}

	public async startChatByContactId(
		session: SessionData,
		token: string,
		contactId: number
	) {
		const process = new ProcessingLogger(
			session.instance,
			"start-chat",
			`${session.userId}-${contactId}_${Date.now()}`,
			{ session, contactId, token }
		);

		try {
			const contact = await prismaService.wppContact.findUnique({
				where: { id: contactId }
			});

			if (!contact) {
				throw new Error("Contato não encontrado!");
			}

			const existingChat = await prismaService.wppChat.findFirst({
				where: {
					instance: session.instance,
					contactId,
					isFinished: false
				}
			});

			if (existingChat) {
				throw new Error("Alguém já está atendendo esse contato!");
			}

			const profilePicture = await whatsappService.getProfilePictureUrl(
				session.instance,
				contact.phone
			);
			const newChat = await prismaService.wppChat.create({
				data: {
					instance: session.instance,
					type: "ACTIVE",
					avatarUrl: profilePicture,
					userId: session.userId,
					contactId,
					sectorId: session.sectorId,
					startedAt: new Date()
				}
			});

			usersService.setAuth(token);
			const user = await usersService.getUserById(session.userId);

			const message = `Atendimento iniciado por ${user.NOME}.`;
			await messagesDistributionService.addSystemMessage(
				newChat,
				message,
				true
			);

			const newChatWithDetails = await prismaService.wppChat.findUnique({
				where: { id: newChat.id },
				include: {
					contact: true,
					messages: true
				}
			});
			let customer: Customer | null = null;

			if (contact.customerId) {
				try {
					customersService.setAuth(token);
					customer = await customersService.getCustomerById(
						contact.customerId
					);
				} catch (err) {
					customer = null;
				}
			}

			const chatWithCustomer = { ...newChatWithDetails, customer };

			await messagesDistributionService.notifyChatStarted(
				process,
				chatWithCustomer as WppChat
			);
		} catch (err) {
			process.log("Erro ao iniciar o atendimento ");
			process.failed(err);
		}
	}

	public async startScheduledChat(
		instance: string,
		sectorId: number,
		contactId: number,
		scheduledFor: number
	) {
		const process = new ProcessingLogger(
			instance,
			"start-chat",
			`${scheduledFor}-${contactId}_${Date.now()}`,
			{ instance, contactId, scheduledFor }
		);

		try {
			const contact = await prismaService.wppContact.findUnique({
				where: { id: contactId }
			});

			if (!contact) {
				throw new Error("Contato não encontrado!");
			}

			const existingChat = await prismaService.wppChat.findFirst({
				where: {
					instance,
					contactId,
					isFinished: false,
					isSchedule: true
				}
			});

			if (existingChat) {
				throw new Error("Alguém já está atendendo esse contato!");
			}

			const profilePicture = await whatsappService.getProfilePictureUrl(
				instance,
				contact.phone
			);
			const newChat = await prismaService.wppChat.create({
				data: {
					instance,
					type: "ACTIVE",
					avatarUrl: profilePicture,
					userId: scheduledFor,
					contactId,
					sectorId,
					startedAt: new Date()
				}
			});

			const message = `Atendimento iniciado pelo sistema.\nMotivo: Retorno agendado.`;
			await messagesDistributionService.addSystemMessage(
				newChat,
				message,
				true
			);

			const newChatWithDetails = await prismaService.wppChat.findUnique({
				where: { id: newChat.id },
				include: {
					contact: true,
					messages: true
				}
			});
			let customer: Customer | null = null;

			if (contact.customerId) {
				try {
					const customers = await instancesService.executeQuery<
						Customer[]
					>(instance, FETCH_CUSTOMERS_QUERY, [[contact.customerId]]);

					customer = customers[0] || null;
				} catch (err) {
					customer = null;
				}
			}

			const chatWithCustomer = { ...newChatWithDetails, customer };

			await messagesDistributionService.notifyChatStarted(
				process,
				chatWithCustomer as WppChat
			);
		} catch (err) {
			process.log("Erro ao iniciar o atendimento ");
			process.failed(err);
		}
	}
}

export default new ChatsService();
