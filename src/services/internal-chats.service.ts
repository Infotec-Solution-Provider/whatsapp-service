import { InternalChat, Prisma } from "@prisma/client";
import {
	FileDirType,
	InternalChatMember,
	InternalMessage,
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
import whatsappService, { getMessageType } from "./whatsapp.service";
import CreateMessageDto from "../dtos/create-message.dto";
import WWEBJSWhatsappClient from "../whatsapp-client/wwebjs-whatsapp-client";
import { Mention, SendFileOptions, SendMessageOptions } from "../types/whatsapp-instance.types";
import OpusAudioConverter from "../utils/opus-audio-converter";

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
	file?: Express.Multer.File | null;
	fileId?: string;
	mentions?: Mention[];
}

interface UpdateInternalGroupData {
	name: string;
	participants: number[];
	wppGroupId: string | null;
}
class InternalChatsService {
	// Cria um grupo interno com um nome e participantes
	public async createInternalChat(
		session: SessionData,
		participantIds: number[],
		isGroup: boolean = false,
		groupName: string | null = null,
		groupId: string | null = null,
		groupImage: Express.Multer.File | null = null
	) {
		const uniqueIds = new Set(participantIds);
		let fileId: number | null = null;

		if (groupImage) {
			const fileData = await filesService.uploadFile({
				instance: session.instance,
				fileName: groupImage.originalname,
				buffer: groupImage.buffer,
				mimeType: groupImage.mimetype,
				dirType: FileDirType.PUBLIC
			});

			fileId = fileData.id;
		}

		const internalChat = await prismaService.internalChat.create({
			data: {
				isGroup,
				groupName,
				wppGroupId: groupId,
				creatorId: session.userId,
				instance: session.instance,
				groupImageFileId: fileId
			}
		});

		await prismaService.internalChatMember.createMany({
			data: Array.from(uniqueIds).map((id) => ({
				userId: id,
				internalChatId: internalChat.id,
				joinedAt: new Date()
			}))
		});

		const result = await prismaService.internalChat.findUnique({
			where: { id: internalChat.id },
			include: {
				messages: true,
				participants: true
			}
		});

		for (const id of uniqueIds) {
			const room: SocketServerUserRoom = `${session.instance}:user:${id}`;

			await socketService.emit(
				SocketEventType.InternalChatStarted,
				room,
				{
					chat: result as unknown as InternalChat & {
						participants: InternalChatMember[];
						messages: InternalMessage[];
					}
				}
			);
		}

		return result;
	}

	// Sobrescreve os participantes de um grupo interno
	public async updateInternalGroup(
		groupId: number,
		data: UpdateInternalGroupData
	) {
		const currentParticipants =
			await prismaService.internalChatMember.findMany({
				where: {
					internalChatId: groupId
				}
			});

		const idsToAdd = data.participants.filter(
			(p) => !currentParticipants.some((c) => c.userId === p)
		);
		const idsToRemove = currentParticipants.filter(
			(p) => !data.participants.includes(p.userId)
		);

		const group = await prismaService.internalChat.update({
			where: { id: groupId },
			data: {
				groupName: data.name,
				wppGroupId: data.wppGroupId,
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
			const room: SocketServerUserRoom = `${group.instance}:user:${id}`;
			await socketService.emit(
				SocketEventType.InternalChatStarted,
				room,
				{
					chat: group as unknown as InternalChat & {
						participants: InternalChatMember[];
						messages: InternalMessage[];
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

	public async updateGroupImage(
		session: SessionData,
		groupId: number,
		file: Express.Multer.File
	) {
		const fileData = await filesService.uploadFile({
			instance: session.instance,
			fileName: file.originalname,
			buffer: file.buffer,
			mimeType: file.mimetype,
			dirType: FileDirType.PUBLIC
		});

		return await prismaService.internalChat.update({
			where: { id: groupId },
			data: {
				groupImageFileId: fileData.id
			}
		});
	}

	public async deleteInternalChat(id: number) {
		const chat = await prismaService.internalChat.findUnique({
			where: { id }
		});

		if (!chat) {
			throw new BadRequestError("Chat not found");
		}

		await prismaService.internalChatMember.deleteMany({
			where: {
				internalChatId: id
			}
		});
		await prismaService.internalMessage.deleteMany({
			where: {
				internalChatId: id
			}
		});

		await prismaService.internalChat.delete({
			where: { id }
		});

		const room: SocketServerInternalChatRoom =
			`${chat.instance}:internal-chat:${id}` as SocketServerInternalChatRoom;
		await socketService.emit(SocketEventType.InternalChatFinished, room, {
			chatId: id
		});
	}

	// Obtém todos os chats internos do usuário
	public async getInternalChatsBySession(session: SessionData) {
		const result = await prismaService.internalChat.findMany({
			where: {
				instance: session.instance,
				participants: {
					some: { userId: session.userId }
				}
			},
			include: {
				messages: true,
				participants: true
			}
		});

		const chats: (InternalChat & { participants: InternalChatMember[] })[] =
			[];
		const messages: InternalMessage[] = [];

		result.forEach((c) => {
			const { messages: msgs, ...chat } = c;
			messages.push(...msgs);
			chats.push(
				chat as unknown as InternalChat & {
					participants: InternalChatMember[];
				}
			);
		});

		return { chats, messages };
	}

	public async getInternalChatsMonitor(session: SessionData) {
		const isTI = session.sectorId === 3 || session.instance !== "nunes";

		const result = await prismaService.internalChat.findMany({
			where: {
				isFinished: false,
				instance: session.instance,
				...(isTI ? {} : { sectorId: session.sectorId })
			},
			include: {
				messages: true,
				participants: true
			}
		});

		const chats: (InternalChat & { participants: InternalChatMember[] })[] =
			[];
		const messages: InternalMessage[] = [];

		result.forEach((c) => {
			const { messages: msgs, ...chat } = c;
			messages.push(...msgs);
			chats.push(
				chat as unknown as InternalChat & {
					participants: InternalChatMember[];
				}
			);
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
				participants: true,
				messages: true
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
			let mentionsText = "";

			if (data.mentions?.length) {
				let mentions = data.mentions;

				if (typeof mentions === "string") {
					try {
						mentions = JSON.parse(mentions);
					} catch (err) {
						throw new BadRequestError(
							"mentions não é um JSON válido"
						);
					}
				}

				if (!Array.isArray(mentions)) {
					throw new BadRequestError("mentions precisa ser um array");
				}

				mentions
					.map((user) => {
						const phone = user.phone?.replace(/\D/g, "");
						if (!phone) {
							process.log("Telefone inválido em menção:", user);
							return null;
						}
						return `${phone}@c.us`;
					})
					.filter((id): id is string => id !== null);

				mentionsText = mentions
					.map((user) => `@${user.name || user.phone}`)
					.join(" ");
			}

			const texto = data.text?.trim() ?? "";
			const usarMentionsText = !!mentionsText && /@\s*$/.test(texto);

			let message = {
				instance: session.instance,
				status: "RECEIVED",
				timestamp: Date.now().toString(),
				from: `user:${session.userId}`,
				type: "chat",
				body: usarMentionsText
					? texto.replace(/@\s*$/, mentionsText)
					: data.text,
				quotedId: data.quotedId ? Number(data.quotedId) : null,
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
				const buffer = data.sendAsAudio
					? await OpusAudioConverter.convert(data.file.buffer)
					: data.file.buffer;

				if (data.sendAsAudio) {
					process.log("Mensagem convertida com sucesso.");
				}
				const file = await filesService.uploadFile({
					instance: session.instance,
					fileName: data.file!.originalname,
					buffer,
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
			if (data.mentions?.length) {
				const mentionsParsed =
					typeof data.mentions === "string"
						? JSON.parse(data.mentions)
						: data.mentions || [];

				const mentionData = mentionsParsed.map((mention: any) => ({
					userId:
						typeof mention === "object"
							? (mention.userId ?? mention.id)
							: mention,
					messageId: savedMsg.id
				}));

				if (mentionData.length > 0) {
					await prismaService.internalMention.createMany({
						data: mentionData
					});
				}
			}
			const room =
				`${session.instance}:internal-chat:${data.chatId}` as SocketServerInternalChatRoom;
			await socketService.emit(SocketEventType.InternalMessage, room, {
				message: savedMsg
			});
			process.success("Mensagem enviada com sucesso.");

			const chat = await prismaService.internalChat.findUnique({
				where: { id: +data.chatId }
			});

			if (chat?.wppGroupId) {
				const sentMsg = await this.sendMessageToWppGroup(
					session,
					chat.wppGroupId,
					data,
					savedMsg
				);

				sentMsg?.wwebjsId &&
					(await prismaService.internalMessage.update({
						where: { id: savedMsg.id },
						data: {
							wwebjsIdStanza: sentMsg.wwebjsIdStanza ?? null,
							wwebjsId: sentMsg.wwebjsId!
						}
					}));
			}
		} catch (err) {
			const msg = sanitizeErrorMessage(err) || "null";
			process.log("Erro ao enviar mensagem: " + msg);
			process.failed(err);
			throw new BadRequestError("Erro ao enviar mensagem " + msg);
		}
	}

	public async receiveMessage(
		groupId: string,
		msg: CreateMessageDto,
		authorName: string
	) {
		const chat = await prismaService.internalChat.findUnique({
			where: {
				wppGroupId: groupId
			}
		});

		if (chat) {
			const { to, sentAt, ...rest } = msg;
			const savedMsg = await prismaService.internalMessage.create({
				data: {
					...rest,
					from: `external:${msg.from}:${authorName}`,
					internalChatId: chat.id
				}
			});

			const room =
				`${msg.instance}:internal-chat:${chat.id}` as SocketServerInternalChatRoom;
			await socketService.emit(SocketEventType.InternalMessage, room, {
				message: savedMsg
			});
		}
	}

	public async sendMessageToWppGroup(
		session: SessionData,
		groupId: string,
		data: InternalSendMessageData,
		message: InternalMessage
	) {
		const client = await whatsappService.getClientBySector(
			session.instance,
			session.sectorId
		);

		if (!(client instanceof WWEBJSWhatsappClient)) {
			return;
		}

		let waMentions: Mention[] = [];
		if (data.mentions) {
			let mentions: Mention[] = [];

			if (typeof data.mentions === "string") {
				mentions = JSON.parse(data.mentions);
			} else if (Array.isArray(data.mentions)) {
				mentions = data.mentions;
			}

			waMentions = mentions.map((m) => ({
				userId: m.userId ?? "",
				phone: m.phone ?? "",
				name: m.name || m.phone || ""
			}));
		}

		const text = `*${session.name}*: ${message.body}`;

		if (data.quotedId) {
			const quotedmsg = await prismaService.internalMessage.findUnique({
				where: { id: +data.quotedId }
			});

			data.quotedId = quotedmsg?.wwebjsId || null;
		}

		if (groupId && client && message.fileId && message.fileName) {
			const fileUrl = filesService.getFileDownloadUrl(message.fileId);
			return await client.sendMessage(
				{
					fileName: message.fileName!,
					fileUrl,
					to: groupId,
					quotedId: data.quotedId || null,
					sendAsAudio: data.sendAsAudio === "true",
					sendAsDocument: data.sendAsDocument === "true",
					text,
					mentions: waMentions
				},
				true
			);
		} else if (groupId && client) {
			return await client.sendMessage(
				{
					to: groupId,
					quotedId: data.quotedId || null,
					text,
					mentions: waMentions
				},
				true
			);
		}

		return await client.sendMessage({
			to: groupId,
			quotedId: data.quotedId || null,
			text: data.text,
			mentions: waMentions
		});
	}

	public async updateMessage(id: number, data: Partial<InternalMessage>) {
		return await prismaService.internalMessage.update({
			where: { id },
			data
		});
	}

	public async markChatMessagesAsRead(chatId: number, userId: number) {
		const lastMsg = await prismaService.internalMessage.findFirst({
			where: {
				internalChatId: chatId
			},
			orderBy: {
				timestamp: "desc"
			}
		});

		await prismaService.internalChatMember.update({
			data: {
				lastReadAt: lastMsg?.timestamp
					? new Date(+lastMsg.timestamp)
					: new Date()
			},
			where: {
				internalChatId_userId: {
					internalChatId: chatId,
					userId
				}
			}
		});
	}

public async forwardWppMessagesToInternal(
    session: SessionData,
    originalMessages: any[],
	sourceType: "whatsapp" | "internal",
    internalTargetChatIds: number[]
): Promise<void> {
    const process = new ProcessingLogger(
        session.instance,
        "forward-wpp-to-internal",
        `user:${session.userId}-${Date.now()}`,
        {
            messageCount: originalMessages.length,
            targetCount: internalTargetChatIds.length
        }
    );

    try {
        process.log(
            `Buscando ${originalMessages.length} mensagem(ns) original(is) do WhatsApp.`
        );

        if (originalMessages.length === 0) {
            process.log(
                "Nenhuma mensagem original encontrada no DB. Encerrando."
            );
            return;
        }

        const client = await whatsappService.getClientBySector(
            session.instance,
            session.sectorId
        );

        for (const chatId of internalTargetChatIds) {
            const internalChat = await prismaService.internalChat.findUnique({
                where: { id: chatId },
                select: { isGroup: true, wppGroupId: true }
            });

            for (const originalMsg of originalMessages) {
                const messageData: Prisma.InternalMessageCreateInput = {
                    instance: session.instance,
                    from: `user:${session.userId}`,
                    type: originalMsg.type,
                    body: originalMsg.body,
                    timestamp: Date.now().toString(),
                    status: "RECEIVED",
                    isForwarded: true,
                    chat: {
                        connect: { id: chatId }
                    },
                    fileId: originalMsg.fileId,
                    fileName: originalMsg.fileName,
                    fileType: originalMsg.fileType,
                    fileSize: originalMsg.fileSize
                };

                const savedInternalMsg =
                    await prismaService.internalMessage.create({
                        data: messageData
                    });

                process.log(
                    `Mensagem ID:${originalMsg.id} encaminhada para Chat Interno ID:${chatId}. Nova msg ID:${savedInternalMsg.id}`
                );

                const room: SocketServerInternalChatRoom = `${session.instance}:internal-chat:${chatId}`;
                await socketService.emit(
                    SocketEventType.InternalMessage,
                    room,
                    {
                        message: savedInternalMsg
                    }
                );

                if (internalChat?.isGroup && internalChat.wppGroupId) {
                    try {
                         if (!(client instanceof WWEBJSWhatsappClient)) {
                            process.log(`Cliente não suporta encaminhamento nativo para o grupo wppId:${internalChat.wppGroupId}`);
                            continue;
                        }

						if (sourceType === "internal") {
							const options: SendMessageOptions | SendFileOptions = {
								to: internalChat.wppGroupId,
								text: originalMsg.body || undefined,
							};

							if (originalMsg.fileId) {
								(options as SendFileOptions).fileUrl = filesService.getFileDownloadUrl(
									originalMsg.fileId
								);
								(options as SendFileOptions).fileName = originalMsg.fileName;
								(options as SendFileOptions).fileType = originalMsg.fileType;
								(options as SendFileOptions).sendAsAudio = originalMsg.type === "ptt";
								(options as SendFileOptions).sendAsDocument = originalMsg.type === "document";
							}

							await client.sendMessage(options,true);
						} else {
							await client.forwardMessage(
								internalChat.wppGroupId,
								originalMsg.wwebjsId!,
								true
							);
						}
                        process.log(
                            `Mensagem ID:${originalMsg.id} também encaminhada para o grupo de WhatsApp ID:${internalChat.wppGroupId}`
                        );
                    } catch (err) {
                        process.failed(
                            `Falha ao encaminhar msg ID:${originalMsg.id} para o grupo de WhatsApp ${internalChat.wppGroupId}: ${sanitizeErrorMessage(err)}`
                        );
                    }
                }
            }
        }
        process.success(
            "Todas as mensagens foram processadas para os chats internos."
        );
    } catch (err) {
        const msg = sanitizeErrorMessage(err) || "null";
        process.failed(
            `Erro ao encaminhar mensagens para chats internos: ${msg}`
        );
        throw new BadRequestError(
            `Erro ao encaminhar para chat interno: ${msg}`
        );
    }
}
}

export default new InternalChatsService();
