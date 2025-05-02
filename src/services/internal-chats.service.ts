import { InternalChat, InternalMessage, Prisma } from "@prisma/client";
import {
	FileDirType,
	SessionData,
	SocketEventType,
	SocketServerInternalChatRoom,
	SocketServerUserRoom
} from "@in.pulse-crm/sdk";
import socketService from "./socket.service";
import ProcessingLogger from "../utils/processing-logger";
import filesService from "./files.service";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { BadRequestError } from "@rgranatodutra/http-errors";
import prismaService from "./prisma.service";
import { getMessageType } from "./whatsapp.service";

interface ChatsFilters {
	userId?: string;
	isFinished?: string;
}

interface InternalSendMessageData {
	sendAsAudio?: string;
	sendAsDocument?: string;
	quotedId?: string | null;
	chatId: string;
	text: string;
	file?: Express.Multer.File;
	fileId?: string;
}

class InternalChatsService {
	// Cria um grupo interno com um nome e participantes
	public async createInternalChat(
		session: SessionData,
		participantIds: number[],
		isGroup: boolean = false,
		groupName: string = ""
	) {
		const uniqueIds = new Set(participantIds);

		const internalChat = await prismaService.internalChat.create({
			data: {
				isGroup,
				groupName,
				creatorId: session.userId,
				instance: session.instance,
				participants: {
					createMany: {
						data: Array.from(uniqueIds).map((id) => ({
							userId: id,
							joinedAt: new Date()
						}))
					}
				}
			},
			include: {
				participants: true
			}
		});

		participantIds.forEach(async (id) => {
			const room: SocketServerUserRoom = `${session.instance}:user:${id}`;

			await socketService.emit(
				SocketEventType.InternalChatStarted,
				room,
				{
					chat: {
						...internalChat,
						participants: participantIds
					}
				}
			);
		});

		return internalChat;
	}

	// Sobrescreve os participantes de um grupo interno
	public async updateInternalChatParticipants(
		groupId: number,
		{ name, participants }: { name: string; participants: number[] }
	) {
		const currentParticipants =
			await prismaService.internalChatMember.findMany({
				where: {
					internalChatId: groupId
				}
			});

		const idsToAdd = participants.filter(
			(p) => !currentParticipants.some((c) => c.userId === p)
		);
		const idsToRemove = currentParticipants.filter(
			(p) => !participants.includes(p.userId)
		);

		const group = await prismaService.internalChat.update({
			where: { id: groupId },
			data: {
				groupName: name,
				participants: {
					createMany: {
						data: idsToAdd.map((id) => ({
							userId: id,
							joinedAt: new Date()
						}))
					},
					deleteMany: {
						internalChatId: groupId,
						userId: {
							in: idsToRemove.map((p) => p.userId)
						}
					}
				}
			},
			include: { participants: true, messages: true }
		});

		for (const id of idsToAdd) {
			const { participants, ...rest } = group;
			const room: SocketServerUserRoom = `${group.instance}:user:${id}`;
			await socketService.emit(
				SocketEventType.InternalChatStarted,
				room,
				{
					chat: {
						...rest,
						participants: group.participants.map((p) => p.userId)
					}
				}
			);
		}

		for (const id of idsToRemove) {
			const room: SocketServerUserRoom = `${group.instance}:user:${id.userId}`;
			await socketService.emit(
				SocketEventType.InternalChatFinished,
				room,
				{
					chatId: groupId
				}
			);
		}

		return group;
	}

	// Obtém todos os chats internos do usuário
	public async getInternalChatsBySession(session: SessionData) {
		const result = await prismaService.internalChat.findMany({
			where: {
				participants: {
					some: { userId: session.userId }
				}
			},
			include: {
				messages: true,
				participants: true
			}
		});
		const chats: (InternalChat & { participants: number[] })[] = [];
		const messages: InternalMessage[] = [];

		result.forEach((chat) => {
			const { messages: msgs, participants, ...rest } = chat;
			messages.push(...msgs);
			chats.push({
				...rest,
				participants: participants.map((p) => p.userId)
			});
		});

		return { chats, messages };
	}

	public async getInternalGroups(session: SessionData) {
		const result = await prismaService.internalChat.findMany({
			where: {
				instance: session.instance,
				isGroup: true,
				isFinished: false
			},
			include: {
				participants: true
			},
			orderBy: {
				startedAt: "desc"
			}
		});

		return result;
	}

	// Obtém todos os chats internos, podendo filtrar
	public async getInternalChats(filters: ChatsFilters) {
		const whereClause: Prisma.InternalChatWhereInput = {};

		if (filters.userId) {
			whereClause.participants = {
				some: {
					userId: +filters.userId
				}
			};
		}

		if (filters.isFinished) {
			whereClause.isFinished =
				filters.isFinished === "true" ? true : false;
		}

		const chats = await prismaService.internalChat.findMany({
			include: {
				messages: true
			},
			where: whereClause
		});

		return chats;
	}

	// Envia uma mensagem no chat interno
	public async sendMessage(
		session: SessionData,
		data: InternalSendMessageData
	) {
		const { file, ...logData } = data;

		const process = new ProcessingLogger(
			session.instance,
			"internal-message",
			`${data.chatId}-${Date.now()}`,
			logData
		);

		process.log("Iniciando o envio da mensagem interna.");
		try {
			let message = {
				instance: session.instance,
				status: "RECEIVED",
				timestamp: Date.now().toString(),
				from: `user:${session.userId}`,
				type: "chat",
				body: data.text || "",
				chat: {
					connect: {
						id: +data.chatId
					}
				}
			} as Prisma.InternalMessageCreateInput;

			if ("fileId" in data) {
				message.fileId = +data.fileId;
			}
			if ("file" in data && !!data.file) {
				const file = await filesService.uploadFile({
					instance: session.instance,
					fileName: data.file!.originalname,
					buffer: data.file!.buffer,
					mimeType: data.file!.mimetype,
					dirType: FileDirType.PUBLIC
				});

				message.fileId = file.id;
				message.fileName = file.name;
				message.fileType = file.mime_type;
				message.fileSize = String(file.size);
				message.type = getMessageType(
					file.mime_type,
					!!data.sendAsAudio,
					!!data.sendAsDocument
				);
			}

			const savedMsg = await prismaService.internalMessage.create({
				data: message
			});
			process.log("Mensagem salva no banco de dados.", savedMsg);
			const room =
				`${session.instance}:internal-chat:${data.chatId}` as SocketServerInternalChatRoom;
			await socketService.emit(SocketEventType.InternalMessage, room, {
				message: savedMsg
			});
			process.success("Mensagem enviada com sucesso.");
		} catch (err) {
			const msg = sanitizeErrorMessage(err) || "null";
			process.log("Erro ao enviar mensagem: " + msg);
			process.failed(err);
			throw new BadRequestError("Erro ao enviar mensagem " + msg);
		}
	}

	public async updateMessage(id: number, data: Partial<InternalMessage>) {
		return await prismaService.internalMessage.update({
			where: { id },
			data
		});
	}
}

export default new InternalChatsService();
