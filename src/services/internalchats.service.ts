import { InternalChat, InternalContact, InternalMessage, Prisma, PrismaClient } from "@prisma/client";
import { Customer, InternalMessageEventData, SendMessageData, SessionData, SocketEventType, SocketServerChatRoom, User } from "@in.pulse-crm/sdk";
import socketService from "./socket.service";
import instancesService from "./instances.service";
import usersService from "./users.service";
import ProcessingLogger from "../classes/processing-logger";
import filesService from "./files.service";
import OpusAudioConverter from "../classes/opus-audio-converter";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { BadRequestError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";
import { SendFileOptions, SendMessageOptions } from "../types/whatsapp-instance.types";
import CreateInternalMessageDto from "../dtos/create-internal-message.dto";

const prisma = new PrismaClient();

interface ChatSummary {
  id: number;
  isGroup: boolean;
  groupName?: string;
  lastMessage?: InternalMessage;
}

interface ChatDetail extends ChatSummary {
  members?: { id: number; name: string; phone: string }[];
  messages: InternalMessage[];
}
interface ChatsFilters {
	userId?: string;
	isFinished?: string;
}
function getMessageType(
	fileType: string,
	isAudio: boolean,
	isDocument: boolean
) {
	if (isDocument) {
		return "document";
	}
	if (isAudio) {
		return "ptt";
	}
	if (fileType.startsWith("image/")) {
		return "image";
	}
	if (fileType.startsWith("video/")) {
		return "video";
	}
	if (fileType.startsWith("audio/")) {
		return "audio";
	}
	return "document";
}
const FETCH_USERS_QUERY = "SELECT * FROM operadores WHERE CODIGO IN (?)";

export default {
	async getChatsForUser(userId: number): Promise<ChatSummary[]> {
		const directs = await prisma.internalChat.findMany({
		where: { isGroup: false, userId },
		include: { messages: true }
		});
		const groups = await prisma.internalChat.findMany({
			where: {
			isGroup: true,
			members: { some: { internalcontactId: userId } } // Corrigido o filtro para a relação 'members'
			},
			include: { messages: true }
		});

		function toSummary(c: any): ChatSummary {
		const last = c.messages.sort((a:any, b:any) => b.timestamp.getTime() - a.timestamp.getTime())[0];
		return {
			id: c.id,
			isGroup: c.isGroup,
			groupName: c.groupName || undefined,
			lastMessage: last || undefined
		};
		}
		return [...directs, ...groups].map(toSummary);
		},

	async getUserChatsBySession(
		session: SessionData,
		includeMessages = true,
		includeContact = true
		) {
		const foundChats = await prisma.internalChat.findMany({
			where: {
				isFinished: false,
				instance: session.instance,
				OR: [
					{
						userId: session.userId
					},
				]
			},
			include: {
				contact: {
					include: {
						messages: true
					}
				}
			}
		});

		if (session.role === "ADMIN") {
			const foundAdminChats = await prisma.internalChat.findMany({
				where: {
					userId: -1,
					sectorId: session.sectorId,
					isFinished: false
				},
				include: {
					contact: {
						include: {
							messages: true
						}
					}
				}
			});

			foundChats.push(...foundAdminChats);
		}

		const chats: Array<
			InternalChat & { user: User | null; contact: InternalContact | null }
		> = [];
		const messages: Array<InternalMessage> = [];
		const customerIds = includeContact
			? foundChats
					.filter(
						(chat) => typeof chat.internalcontactId === "number"
					)
					.map((c) => c.internalcontactId!)
			: [];

		const users = customerIds.length
			? await instancesService.executeQuery<Array<User>>(
					session.instance,
					FETCH_USERS_QUERY,
					[
						foundChats
							.filter(
								(chat) =>
									typeof chat.internalcontactId === "number"
							)
							.map((c) => c.internalcontactId!)
					]
				)
			: [];

		for (const foundChat of foundChats) {
			const { contact, ...chat } = foundChat;

			let user: User | null = null;

			if (includeContact && typeof contact?.userId == "number") {
				user =
				users.find((c) => c.CODIGO === contact.userId) ||
					null;
			}

			chats.push({ ...chat, user, contact: contact || null });

			if (includeMessages && contact) {
				messages.push(...contact.messages);
			}
		}

		return { chats, messages };
		},
	async getContactsWithUser(instance: string, token: string) {
		const chats = await this.getChats({ isFinished: "false" });
		usersService.setAuth(token);

		const res = await usersService.getUsers();
		const users: Map<number, User> = new Map();

		res.data.forEach((user) => {
			users.set(user.CODIGO, user);
		});

		const contacts = await prisma.internalContact.findMany({
			where: { instance },
		});

		// Sincroniza users com internalContacts
		for (const user of res.data) {
			const existingContact = contacts.find(
			(contact) => contact.userId === user.CODIGO
			);

			if (!existingContact) {
			// Se não existe, cria
			await prisma.internalContact.create({
				data: {
				name: user.NOME,
				phone: user.CODIGO.toString(),
				userId: user.CODIGO,
				instance,
				isDeleted: false,
				isBlocked: false,
				isOnlyAdmin: false,
				},
			});
			} else if (existingContact.phone !== user.CODIGO.toString()) {
			// Se existe mas o telefone é diferente, atualiza
			await prisma.internalContact.update({
				where: { id: existingContact.id },
				data: { phone: user.LOGIN },
			});
			}
		}

		// Recarrega contatos atualizados
		const updatedContacts = await prisma.internalContact.findMany({
			where: { instance },
		});

		return updatedContacts.map((contact) => {
			const usuario =
			contact.userId && res.data.find((c) => c.CODIGO === contact.userId);
			const chat = chats.find((c) => c.internalcontactId === contact.id);
			const user = chat
			? users.get(chat.userId || -200)?.NOME || "Supervisão"
			: null;

			return {
			...contact,
			usuario: usuario || null,
			chatingWith: user,
			};
		});
		},
	async startInternalChatByContactId(
		session: SessionData,
		token: string,
		internalcontactId: number
	) {
		const contact = await prisma.internalContact.findUnique({
			where: { id: internalcontactId }
		});

		if (!contact) {
			throw new Error("Contato não encontrado!");
		}

		const existingChat = await prisma.internalChat.findFirst({
			where: {
				instance: session.instance,
				internalcontactId,
				isFinished: false
			}
		});

		if (existingChat) {
			throw new Error("Alguém já está atendendo esse contato!");
		}


		const newChat = await prisma.internalChat.create({
			data: {
				instance: session.instance,
				userId: session.userId,
				internalcontactId,
				sectorId: session.sectorId,
				startedAt: new Date()
			}
		});

		usersService.setAuth(token);

		const newChatWithDetails = await prisma.internalChat.findUnique({
			where: { id: newChat.id },
			include: {
				contact: true,
				messages: true
			}
		});
		let user: User | null = null;

		if (contact.userId) {
			try {
				usersService.setAuth(token);
				user = await usersService.getUserById(
					contact.userId
				);
			} catch (err) {
				user = null;
			}
		}

		return { ...newChatWithDetails, user };
		},

	async getChats(filters: ChatsFilters) {
		const whereClause: Prisma.InternalChatWhereInput = {};

		if (filters.userId) {
			whereClause.userId = +filters.userId;
		}

		if (filters.isFinished) {
			whereClause.isFinished =
				filters.isFinished === "true" ? true : false;
		}

		const chats = await prisma.internalChat.findMany({
			include: {
				messages: true,
				contact: true
			},
			where: whereClause
		});

		return chats;
	},
  async getChatById(chatId: number): Promise<ChatDetail | null> {
    const chat = await prisma.internalChat.findUnique({
      where: { id: chatId },
      include: {
        messages: { orderBy: { timestamp: 'asc' } },
        members: { include: { contact: true } }
      }
    });
    if (!chat) return null;
    const detail: ChatDetail = {
      id: chat.id,
      isGroup: chat.isGroup,
      groupName: chat.groupName ?? '',
	  members: chat.isGroup
	  ? chat.members.map(m => ({ id: m.internalcontactId!, name: m.contact!.name, phone: m.contact!.phone }))
	  : [],
      messages: chat.messages as unknown as InternalMessage[]
    };
    return detail;
  },

   async insertMessage(data: CreateInternalMessageDto) {
	return await prisma.internalMessage.create({ data });
	},

 async updateMessage(id: number, data: Partial<InternalMessage>) {
	return await prisma.internalMessage.update({
		where: { id },
		data
	});
},
 async sendMessage(
	session: SessionData,
	to: string,
	data: SendMessageData
) {
	const { file, ...logData } = data;
	const process = new ProcessingLogger(
		session.instance,
		"send-message",
		`${to}-${Date.now()}`,
		logData
	);

	process.log("Iniciando o envio da mensagem.");
	try {

		let message = {
			instance: session.instance,
			status: "PENDING",
			timestamp: Date.now().toString(),
			from: `me:${session.userId}`,
			to: `${to}`,
			type: "chat",
			body: data.text || ""
		} as CreateInternalMessageDto;
		let options = { to, text: data.text } as SendMessageOptions;

		data.contactId && (message.internalcontactId = +data.contactId);
		data.chatId && (message.internalchatId = +data.chatId);

		if (data.quotedId) {
			process.log(`Mensagem citada encontrada: ${data.quotedId}`);
			const quotedMsg =
				await prisma.internalMessage.findUniqueOrThrow({
					where: {
						id: data.quotedId
					}
				});

			message.quotedId = quotedMsg.id;
		}

		if ("fileId" in data && !!data.fileId) {
			process.log(`Processando arquivo com ID: ${data.fileId}`);

			const fileData = await filesService.fetchFileMetadata(
				data.fileId
			);

			process.log(`Arquivo encontrado: ${fileData.name}`);

			options = {
				...options,
				fileUrl: filesService.getFileDownloadUrl(data.fileId),
				sendAsAudio: !!data.sendAsAudio,
				sendAsDocument: !!data.sendAsDocument,
				fileName: fileData.name
			} as SendFileOptions;

			message.fileId = data.fileId;
			message.fileName = fileData.name;
			message.fileType = fileData.mime_type;
			message.fileSize = String(fileData.size);
			message.type = getMessageType(
				fileData.mime_type,
				!!data.sendAsAudio,
				!!data.sendAsDocument
			);
			process.log("Arquivo processado com sucesso.", message);
		}

		if ("file" in data && !!data.file) {

				if (data.sendAsAudio) {
				process.log(
					"Mensagem de audio, convertendo arquivo para mp3."
				);
			}

			let fileUrl = filesService.getFileDownloadUrl(1);

			options = {
				...options,
				fileUrl,
				sendAsAudio: data.sendAsAudio,
				sendAsDocument: data.sendAsDocument
			} as SendFileOptions;


			message.type = getMessageType(
				data.file.name,
				!!data.sendAsAudio,
				!!data.sendAsDocument
			);
			process.log("Arquivo processado com sucesso.", message);
		}

		process.log("Salvando mensagem no banco de dados.", message);
		const sentMsg = await this.insertMessage(message);
		process.log("Enviando mensagem para o cliente.");


		try {
			process.log("Transmitindo mensagem via socket.");
			const instance = sentMsg.instance;
			const room: SocketServerChatRoom = `${instance}:chat:${sentMsg.internalchatId}`;
			const data: InternalMessageEventData = {  message: {
				...sentMsg,
				timestamp: sentMsg.timestamp instanceof Date
				  ? sentMsg.timestamp.toISOString()
				  : sentMsg.timestamp,
			  } };

			await socketService.emit(SocketEventType.InternalMessage, room, data);
			process.log(`Mensagem transmitida para a sala: /${room}/ room!`);
		} catch (err) {
			const msg = sanitizeErrorMessage(err);
			process.log(`Falha ao transmitir mensagem: ${msg}`);
			throw err;
		}
		process.success(sentMsg);

		return sentMsg;
	} catch (err) {
		console.error(err);
		process.failed(
			"Erro ao enviar mensagem: " + sanitizeErrorMessage(err)
		);
		throw new BadRequestError("Erro ao enviar mensagem.", err);
	}
},
  async createGroup(name: string, creatorId: number, participantIds: number[]) {
    const group = await prisma.internalChat.create({
      data: {
        isGroup: true,
        groupName: name,
        internalcontactId: creatorId,
        members: { create: participantIds.map(id => ({ internalcontactId: id })) },
		instance: 'some-instance-value'

      },
      include: { members: true }
    });

    const room: SocketServerChatRoom = `instance_x:chat:${group.id}`;
    await socketService.emit(SocketEventType.InternalChatStarted, room, { chatId: group.id });

    return group;
  },

  async updateGroupMembers(groupId: number, add: number[], remove: number[]) {
    const additions = add.map(id => prisma.internalChatMember.create({ data: { internalchatId: groupId, internalcontactId: id } }));
    const removals = remove.map(id => prisma.internalChatMember.delete({ where: { internalchatId_internalcontactId: { internalchatId: groupId, internalcontactId: id } } }));
    await Promise.all([...additions, ...removals]);
    return await this.getChatById(groupId);
  }
};
