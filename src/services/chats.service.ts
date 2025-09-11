import { Prisma, WppChat, WppContact, WppMessage } from "@prisma/client";
import prismaService from "./prisma.service";
import {
	Customer,
	SessionData,
	SocketEventType,
	SocketServerMonitorRoom,
	SocketServerUserRoom
} from "@in.pulse-crm/sdk";
import customersService from "./customers.service";
import instancesService from "./instances.service";
import socketService from "./socket.service";
import messagesDistributionService from "./messages-distribution.service";
import usersService from "./users.service";
import whatsappService, { SendTemplateData } from "./whatsapp.service";
import ProcessingLogger from "../utils/processing-logger";
import exatronSatisfactionBot from "../bots/exatron-satisfaction.bot";

interface InpulseResult {
	NOME: string;
}

interface ChatsFilters {
	userId?: string;
	isFinished?: string;
}

export const FETCH_CUSTOMERS_QUERY =
	"SELECT * FROM clientes WHERE CODIGO IN (?)";
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
				},
				schedule: true
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
					},
					schedule: true
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
				const decodedMessages = contact.WppMessage.map((msg) => {
					if (
						session.instance === "vollo" &&
						typeof msg.body === "string"
					) {
						try {
							return {
								...msg,
								body: decodeURIComponent(msg.body)
							};
						} catch (e) {
							return msg;
						}
					}
					return msg;
				});

				messages.push(...decodedMessages);
			}
		}

		return { chats, messages };
	}

	public async getChatsMonitor(
		session: SessionData,
		includeMessages = true,
		includeCustomer = true
	) {
		const isTI = session.sectorId === 3 || session.instance !== "nunes";

		const ongoingChats = await prismaService.wppChat.findMany({
			where: {
				instance: session.instance,
				isFinished: false,
				...(isTI ? {} : { sectorId: session.sectorId })
			},
			include: {
				contact: {
					include: {
						WppMessage: includeMessages
					}
				},
				schedule: true
			}
		});

		const finishedChats = await prismaService.wppChat.findMany({
			where: {
				instance: session.instance,
				...(isTI ? {} : { sectorId: session.sectorId }),
				isFinished: true
			},
			include: {
				contact: true,
				schedule: true
			}
		});

		const chats: Array<
			WppChat & { customer: Customer | null; contact: WppContact | null }
		> = [];
		const messages: Array<WppMessage> = [];
		const customerIds = includeCustomer
			? ongoingChats
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
					ongoingChats
						.filter(
							(chat) =>
								typeof chat.contact?.customerId === "number"
						)
						.map((c) => c.contact!.customerId!)
				]
			)
			: [];

		for (const foundChat of ongoingChats) {
			const { contact, ...chat } = foundChat;

			let customer: Customer | null = null;

			if (includeCustomer && typeof contact?.customerId == "number") {
				customer =
					customers.find((c) => c.CODIGO === contact.customerId) ||
					null;
			}

			chats.push({ ...chat, customer, contact: contact || null });

			if (includeMessages && contact) {
				const decodedMessages = contact.WppMessage.map((msg) => {
					if (
						session.instance === "vollo" &&
						typeof msg.body === "string"
					) {
						try {
							return {
								...msg,
								body: decodeURIComponent(msg.body)
							};
						} catch (e) {
							return msg;
						}
					}
					return msg;
				});

				messages.push(...decodedMessages);
			}
		}

		for (const foundChat of finishedChats) {
			const { contact, ...chat } = foundChat;

			let customer: Customer | null = null;

			if (includeCustomer && typeof contact?.customerId == "number") {
				customer =
					customers.find((c) => c.CODIGO === contact.customerId) ||
					null;
			}

			chats.push({ ...chat, customer, contact: contact || null });
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
				contact: true,
				schedule: true
			},
			where: whereClause
		});

		return chats;
	}

	public async getChatById(id: number) {
		const chat = await prismaService.wppChat.findUnique({
			where: { id },
			include: {
				contact: true
			}
		});

		const messages = chat?.contactId
			? await prismaService.wppMessage.findMany({
				where: { contactId: chat?.contactId },
				orderBy: { timestamp: "asc" }
			})
			: [];

		if (chat?.contact?.customerId) {
			try {
				const customer = await customersService.getCustomerById(
					chat.contact.customerId
				);

				return { ...chat, customer, messages };
			} catch (err) {
				return { ...chat, messages };
			}
		}

		return { ...chat, messages };
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
		const event = SocketEventType.WppChatTransfer;
		const monitorRoom: SocketServerMonitorRoom = `${chat.instance}:${chat.sectorId!}:monitor`;

		if (chat.userId === null || chat.userId === undefined) {
			throw new Error(
				"chat.userId is null or undefined, cannot construct userRoom."
			);
		}

		const userRoom: SocketServerUserRoom = `${chat.instance}:user:${chat.userId}`;

		const transferMsg = `Atendimento transferido por ${user.NOME}.`;
		await messagesDistributionService.addSystemMessage(chat, transferMsg);
		await socketService.emit(event, `${instance}:chat:${chat.id}`, {
			chatId: chat.id
		});
		await socketService.emit(SocketEventType.WppChatStarted, monitorRoom, {
			chatId: chat.id
		});
		await socketService.emit(SocketEventType.WppChatStarted, userRoom, {
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
			},
			include: {
				contact: true
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

		if (session.sectorId === 16 || session.instance === 'develop') {
			await exatronSatisfactionBot.startBot(chat, chat.contact!, chat.contact!.phone,)
		}
	}

	public async startChatByContactId(
		session: SessionData,
		token: string,
		contactId: number,
		template?: SendTemplateData
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
				},
				include: {
					contact: true,
					messages: {
						where: {
							contactId: contact.id
						}
					}
				}
			});

			usersService.setAuth(token);
			const user = await usersService.getUserById(session.userId);

			const message = `Atendimento iniciado por ${user.NOME}.`;
			await messagesDistributionService.addSystemMessage(
				newChat as WppChat,
				message,
				true
			);

			if (template && newChat.contact) {
				await whatsappService.sendTemplate(
					session,
					newChat.contact.phone,
					template,
					newChat.id,
					newChat.contact.id
				);
			}

			await messagesDistributionService.notifyChatStarted(
				process,
				newChat as WppChat
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
					startedAt: new Date(),
					isSchedule: true
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
					messages: {
						where: {
							contactId
						}
					}
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

			return newChatWithDetails!.id;
		} catch (err) {
			process.log("Erro ao iniciar o atendimento ");
			process.failed(err);

			return null;
		}
	}
}

export default new ChatsService();
