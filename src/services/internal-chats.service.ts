import {
	FileDirType,
	InternalChatMember,
	InternalMessage,
	SessionData,
	SocketEventType,
	SocketServerInternalChatRoom,
	SocketServerUserRoom
} from "@in.pulse-crm/sdk";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { InternalChat, Prisma } from "@prisma/client";
import { BadRequestError } from "@rgranatodutra/http-errors";
import { Mention } from "../types/whatsapp-instance.types";
import ProcessingLogger from "../utils/processing-logger";
import WhatsappAudioConverter from "../utils/whatsapp-audio-converter";
import filesService from "./files.service";
import prismaService from "./prisma.service";
import socketService from "./socket.service";
import whatsappService, { getMessageType } from "./whatsapp.service";
import { createUploadTraceLogger } from "../utils/file-upload-trace";
import getUsersClient from "./users.service";

interface ChatsFilters {
	userId?: string;
	isFinished?: string;
}

interface InternalSendMessageData {
	sendAsAudio?: string | boolean;
	sendAsDocument?: string | boolean;
	quotedId?: string | null;
	chatId: string;
	text: string;
	file?: Express.Multer.File | null;
	fileId?: string;
	mentions?: Mention[] | string;
	traceId?: string;
	authToken?: string;
}

interface UpdateInternalGroupData {
	name: string;
	participants: number[];
	wppGroupId: string | null;
}

interface EditInternalMessageOptions {
	messageId: number;
	text: string;
}
class InternalChatsService {
	// Cria um grupo interno com um nome e participantes
	public async createInternalChat(
		session: SessionData,
		participantIds: number[],
		isGroup: boolean = false,
		groupName: string | null = null,
		_groupId: string | null = null,
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
				wppGroupId: null,
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

			await socketService.emit(SocketEventType.InternalChatStarted, room, {
				chat: result as unknown as InternalChat & {
					participants: InternalChatMember[];
					messages: InternalMessage[];
				}
			});
		}

		return result;
	}

	// Sobrescreve os participantes de um grupo interno
	public async updateInternalGroup(groupId: number, data: UpdateInternalGroupData) {
		const currentParticipants = await prismaService.internalChatMember.findMany({
			where: {
				internalChatId: groupId
			}
		});

		const idsToAdd = data.participants.filter((p) => !currentParticipants.some((c) => c.userId === p));
		const idsToRemove = currentParticipants.filter((p) => !data.participants.includes(p.userId));

		const group = await prismaService.internalChat.update({
			where: { id: groupId },
			data: {
				groupName: data.name,
				wppGroupId: null,
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
			await socketService.emit(SocketEventType.InternalChatStarted, room, {
				chat: group as unknown as InternalChat & {
					participants: InternalChatMember[];
					messages: InternalMessage[];
				}
			});
		}

		for (const id of idsToRemove) {
			const room: SocketServerUserRoom = `${group.instance}:user:${id.userId}`;
			await socketService.emit(SocketEventType.InternalChatFinished, room, {
				chatId: groupId
			});
		}

		return group;
	}

	public async updateGroupImage(session: SessionData, groupId: number, file: Express.Multer.File) {
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

	public async finishInternalChat(session: SessionData, id: number) {
		const chat = await prismaService.internalChat.findUnique({
			where: { id }
		});

		if (!chat) {
			throw new BadRequestError("Chat not found");
		}

		if (chat.isGroup) {
			throw new BadRequestError("Group chats cannot be finished by this endpoint");
		}

		if (chat.isFinished) {
			return chat;
		}

		const updated = await prismaService.internalChat.update({
			where: { id },
			data: {
				isFinished: true,
				finishedAt: new Date(),
				finishedBy: session.userId
			}
		});

		const room: SocketServerInternalChatRoom =
			`${chat.instance}:internal-chat:${id}` as SocketServerInternalChatRoom;
		await socketService.emit(SocketEventType.InternalChatFinished, room, {
			chatId: id
		});

		return updated;
	}

	// Obtém todos os chats internos do usuário
	public async getInternalChatsBySession(session: SessionData) {
		const result = await prismaService.internalChat.findMany({
			where: {
				instance: session.instance,
				isFinished: false,
				participants: {
					some: { userId: session.userId }
				}
			},
			include: {
				messages: true,
				participants: true
			}
		});

		const chats: (InternalChat & { participants: InternalChatMember[] })[] = [];
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

		const chats: (InternalChat & { participants: InternalChatMember[] })[] = [];
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
			whereClause.isFinished = filters.isFinished === "true" ? true : false;
		}

		const chats = await prismaService.internalChat.findMany({
			include: {
				messages: true
			},
			where: whereClause
		});

		return chats;
	}

	private parseMentions(rawMentions: InternalSendMessageData["mentions"], process: ProcessingLogger): Mention[] {
		if (!rawMentions) {
			return [];
		}

		let mentions = rawMentions;

		if (typeof mentions === "string") {
			process.log(`Menções em formato string, parseando JSON`);
			try {
				mentions = JSON.parse(mentions) as Mention[];
			} catch (err) {
				process.log(`Erro ao fazer parse de menções: ${sanitizeErrorMessage(err)}`);
				throw new BadRequestError("mentions não é um JSON válido");
			}
		}

		if (!Array.isArray(mentions)) {
			process.log(`Menções não é um array`);
			throw new BadRequestError("mentions precisa ser um array");
		}

		return mentions;
	}

	private async resolveMentionsWithTodos(
		session: SessionData,
		chatId: number,
		text: string,
		mentions: Mention[],
		process: ProcessingLogger
	): Promise<Mention[]> {
		const mentionByUserId = new Map<number, Mention>();

		for (const mention of mentions) {
			if (Number.isInteger(mention.userId) && mention.userId > 0) {
				mentionByUserId.set(mention.userId, mention);
			}
		}

		const hasTodosMention = /(^|\s)@todos\b/i.test(text || "");

		if (!hasTodosMention) {
			return Array.from(mentionByUserId.values());
		}

		process.log(`Menção especial @todos detectada. Expandindo para participantes do chat ${chatId}`);

		const participants = await prismaService.internalChatMember.findMany({
			where: {
				internalChatId: chatId,
				userId: { not: session.userId },
				chat: {
					instance: session.instance
				}
			},
			select: {
				userId: true
			}
		});

		for (const participant of participants) {
			if (!mentionByUserId.has(participant.userId)) {
				mentionByUserId.set(participant.userId, {
					userId: participant.userId,
					name: `user:${participant.userId}`
				});
			}
		}

		process.log(
			`@todos expandido para ${participants.length} participante(s); total de destinatários únicos: ${mentionByUserId.size}`
		);

		return Array.from(mentionByUserId.values());
	}

	private async notifyMentionsViaWhatsapp(
		session: SessionData,
		chatId: number,
		message: InternalMessage,
		mentions: Mention[],
		process: ProcessingLogger,
		authToken?: string
	): Promise<void> {
		if (!mentions.length) {
			return;
		}

		process.log(`Iniciando notificação WhatsApp para ${mentions.length} menção(ões)`);

		if (!authToken) {
			process.log(`Notificação de menções ignorada: token de autenticação ausente para resolver WHATSAPP dos operadores`);
			return;
		}

		const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });

		if (!sector?.defaultClientId) {
			process.log(`Notificação de menções ignorada: setor sem cliente WhatsApp padrão`);
			return;
		}

		const client = whatsappService.getClient(sector.defaultClientId);

		if (!client) {
			process.log(`Notificação de menções ignorada: cliente WhatsApp não disponível`);
			return;
		}

		const notificationText = `*${session.name}* mencionou você no chat interno #${chatId}:\n${message.body || "(sem texto)"}`;
		const usersClient = getUsersClient();
		usersClient.setAuth(authToken);

		const mentionByUserId = new Map<number, Mention>();
		for (const mention of mentions) {
			if (Number.isInteger(mention.userId) && mention.userId > 0 && !mentionByUserId.has(mention.userId)) {
				mentionByUserId.set(mention.userId, mention);
			}
		}

		const mentionedUserIds = Array.from(mentionByUserId.keys());

		if (!mentionedUserIds.length) {
			process.log(`Notificação de menções ignorada: nenhuma menção com userId válido`);
			return;
		}

		const usersResults = await Promise.allSettled(
			mentionedUserIds.map((userId) => usersClient.getUserById(userId))
		);

		const targets: Array<{ mention: Mention; phone: string }> = [];
		let skippedWithoutWhatsapp = 0;
		let skippedLookupError = 0;

		usersResults.forEach((result, index) => {
			const userId = mentionedUserIds[index];

			if (typeof userId !== "number") {
				return;
			}

			const mention = mentionByUserId.get(userId);

			if (!mention) {
				return;
			}

			if (result.status === "rejected") {
				skippedLookupError++;
				process.log(
					`Menção ignorada para userId ${userId}: falha ao buscar operador (${sanitizeErrorMessage(result.reason)})`
				);
				return;
			}

			const phone = result.value?.WHATSAPP?.replace(/\D/g, "") || "";

			if (!phone) {
				skippedWithoutWhatsapp++;
				process.log(`Menção ignorada para userId ${userId}: operador sem WHATSAPP válido`);
				return;
			}

			targets.push({ mention, phone });
		});

		process.log(
			`Menções elegíveis para WhatsApp: ${targets.length}/${mentionedUserIds.length} (sem WHATSAPP: ${skippedWithoutWhatsapp}, erro lookup: ${skippedLookupError})`
		);

		if (!targets.length) {
			process.log(`Notificação de menções ignorada: nenhum operador elegível para envio via WhatsApp`);
			return;
		}

		const notificationResults = await Promise.allSettled(
			targets.map(({ phone }) =>
				client.sendMessage({
					to: `${phone}@c.us`,
					text: notificationText
				})
			)
		);

		notificationResults.forEach((result, index) => {
			if (result.status === "fulfilled") {
				return;
			}

			const target = targets[index];
			process.log(
				`Falha ao notificar menção via WhatsApp para ${target?.mention.name || target?.phone}: ${sanitizeErrorMessage(result.reason)}`
			);
		});
	}

	// Envia uma mensagem no chat interno
	public async sendMessage(session: SessionData, data: InternalSendMessageData) {
		const { file, authToken, ...logData } = data;
		const sendAsAudio = data.sendAsAudio === true || data.sendAsAudio === "true";
		const sendAsDocument = data.sendAsDocument === true || data.sendAsDocument === "true";
		const chatId = +data.chatId;
		const traceId = data.traceId || `${data.chatId}-${Date.now()}`;
		const trace = createUploadTraceLogger("whatsapp-service.service.internal-chats", traceId);

		const process = new ProcessingLogger(
			session.instance,
			"internal-message",
			traceId,
			logData
		);

		process.log(
			`Iniciando envio de mensagem interna. Usuário: ${session.userId} (${session.name}), Chat ID: ${data.chatId}`
		);
		process.log(
			`Dados da requisição - Tipo de mensagem: ${sendAsAudio ? "áudio" : sendAsDocument ? "documento" : "texto"}, Com arquivo: ${!!file}, Com citação: ${!!data.quotedId}, Menções: ${data.mentions?.length || 0}`
		);
		trace.info("internal-message.start", {
			chatId: data.chatId,
			hasFile: !!file,
			fileId: data.fileId,
			fileName: file?.originalname,
			fileSize: file?.size,
			fileType: file?.mimetype,
			sendAsAudio,
			sendAsDocument,
		});

		try {
			const parsedMentions = this.parseMentions(data.mentions, process);
			const resolvedMentions = await this.resolveMentionsWithTodos(
				session,
				chatId,
				data.text || "",
				parsedMentions,
				process
			);
			let mentionsText = "";

			if (resolvedMentions.length) {
				process.log(`Processando ${resolvedMentions.length} menção(ões) resolvida(s)`);

				process.log(`Validando telefones nas menções`);
				resolvedMentions
					.map((user) => {
						const phone = user.phone?.replace(/\D/g, "");
						if (!phone) {
							process.log(`Aviso: Telefone inválido em menção de usuário: ${user.name}`);
							return null;
						}
						return `${phone}@c.us`;
					})
					.filter((id): id is string => id !== null);

				mentionsText = resolvedMentions.map((user) => `@${user.name || user.phone || user.userId}`).join(" ");
				process.log(`Texto de menções formatado: "${mentionsText}"`);
			}

			const texto = data.text?.trim() ?? "";
			const usarMentionsText = !!mentionsText && /@\s*$/.test(texto);

			let message = {
				instance: session.instance,
				status: "PENDING",
				timestamp: Date.now().toString(),
				from: `user:${session.userId}`,
				type: "chat",
				body: usarMentionsText ? texto.replace(/@\s*$/, mentionsText) : data.text,
				quotedId: data.quotedId ? Number(data.quotedId) : null,
				isForwarded: false,
				isEdited: false,
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
				process.log(
					`Processando arquivo anexado: ${data.file.originalname} (${data.file.size} bytes, mime: ${data.file.mimetype})`
				);
				trace.info("internal-message.file.process.start", {
					fileName: data.file.originalname,
					fileSize: data.file.size,
					fileType: data.file.mimetype,
				});

				if (sendAsAudio) {
					process.log(
						`Convertendo arquivo para áudio compatível (extensão: ${data.file.originalname.split(".").pop()})`
					);
					const convertedAudio = await WhatsappAudioConverter.convertToCompatible(
						data.file.buffer,
						data.file.mimetype
					);

					process.log(
						`Arquivo de áudio convertido para ${convertedAudio.extension} (${convertedAudio.size} bytes)`
					);

					data.file.buffer = convertedAudio.buffer;
					data.file.mimetype = convertedAudio.mimeType;
					data.file.originalname = data.file.originalname.replace(
						/\.[^/.]+$/,
						"." + convertedAudio.extension
					);
					data.file.size = convertedAudio.size;
				}

				process.log(`Fazendo upload do arquivo para o serviço de armazenamento`);
				const file = await filesService.uploadFile({
					instance: session.instance,
					fileName: data.file!.originalname,
					buffer: data.file!.buffer,
					mimeType: data.file!.mimetype,
					dirType: FileDirType.PUBLIC,
					traceId,
				});
				trace.info("internal-message.file.upload.success", {
					fileId: file.id,
					fileName: file.name,
					fileSize: file.size,
					fileType: file.mime_type,
				});

				process.log(
					`Arquivo enviado com sucesso. File ID: ${file.id}, Nome: ${file.name}, Tamanho: ${file.size} bytes`
				);

				message.fileId = file.id;
				message.fileName = file.name;
				message.fileType = file.mime_type;
				message.fileSize = String(file.size);
				message.type = getMessageType(file.mime_type, sendAsAudio, sendAsDocument);
			}

			process.log(`Salvando mensagem no banco de dados do chat ID: ${data.chatId}`);
			const savedMsg = await prismaService.internalMessage.create({
				data: message
			});
			trace.info("internal-message.persist.success", { messageId: savedMsg.id, fileId: savedMsg.fileId });
			process.log(
				`Mensagem salva com sucesso. ID da mensagem: ${savedMsg.id}, Tipo: ${savedMsg.type}, Status: ${savedMsg.status}`
			);

			if (resolvedMentions.length) {
				process.log(`Persistindo ${resolvedMentions.length} menção(ões)`);
				const mentionData = resolvedMentions.map((mention) => ({
					userId: mention.userId,
					messageId: savedMsg.id
				}));

				if (mentionData.length > 0) {
					process.log(`Salvando ${mentionData.length} menção(ões) no banco de dados`);
					await prismaService.internalMention.createMany({
						data: mentionData
					});
					process.log(`Menções salvas com sucesso`);
				}
			}

			process.log(
				`Emitindo evento de mensagem interna via socket para a sala: ${session.instance}:internal-chat:${data.chatId}`
			);
			const room = `${session.instance}:internal-chat:${data.chatId}` as SocketServerInternalChatRoom;
			await socketService.emit(SocketEventType.InternalMessage, room, {
				message: savedMsg
			});
			process.log(`Evento de socket emitido com sucesso`);

			process.log(`Emitindo status inicial SENT para mensagem interna`);
			await socketService.emit(SocketEventType.InternalMessageStatus, room, {
				chatId,
				internalMessageId: savedMsg.id,
				status: "SENT"
			});

			await prismaService.internalMessage.update({
				where: { id: savedMsg.id },
				data: { status: "RECEIVED" }
			});
			process.log(`Mensagem interna marcada como RECEIVED`);

			await socketService.emit(SocketEventType.InternalMessageStatus, room, {
				chatId,
				internalMessageId: savedMsg.id,
				status: "RECEIVED"
			});

			if (resolvedMentions.length) {
				trace.info("internal-message.mentions-notification.start", {
					chatId,
					messageId: savedMsg.id,
					mentions: resolvedMentions.length
				});

				try {
					await this.notifyMentionsViaWhatsapp(session, chatId, savedMsg, resolvedMentions, process, authToken);
					trace.info("internal-message.mentions-notification.success", {
						chatId,
						messageId: savedMsg.id
					});
				} catch (err) {
					process.log(
						`Falha ao notificar menções via WhatsApp: ${sanitizeErrorMessage(err)}. Fluxo interno permanece concluído.`
					);
					trace.error("internal-message.mentions-notification.failed", err, {
						chatId,
						messageId: savedMsg.id
					});
				}
			}

			process.success("Mensagem enviada com sucesso.");
		} catch (err) {
			trace.error("internal-message.failed", err, {
				chatId: data.chatId,
				fileId: data.fileId,
				hasFile: !!data.file,
			});
			const msg = sanitizeErrorMessage(err) || "null";
			process.log(`Erro durante envio de mensagem: ${msg}`);
			process.log(`Stack trace: ${(err as Error).stack}`);
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

	public async getInternalMessageById(session: SessionData, id: number) {
		const message = await prismaService.internalMessage.findUnique({
			where: { id },
			include: {
				chat: true
			}
		});

		if (!message) {
			throw new Error("Internal message not found!");
		}

		if (message.instance !== session.instance) {
			throw new Error("This message does not belong to your instance!");
		}

		return message;
	}

	public async editInternalMessage({
		options,
		session
	}: {
		options: EditInternalMessageOptions;
		session: SessionData;
	}) {
		const process = new ProcessingLogger(
			session.instance,
			"internal-message-edit",
			`${options.messageId}_${Date.now()}`,
			options
		);

		try {
			process.log("Iniciando edição de mensagem interna.");

			// Verifica se a mensagem existe e pertence à instância do usuário
			const originalMsg = await this.getInternalMessageById(session, options.messageId);
			process.log("Mensagem original encontrada.", originalMsg);

			// Verifica se o usuário que está tentando editar é o autor da mensagem
			const authorId = originalMsg.from.startsWith("user:") ? originalMsg.from.replace("user:", "") : null;
			if (authorId !== session.userId.toString()) {
				throw new Error("You can only edit your own messages!");
			}

			// Atualiza a mensagem no banco
			const updatedMsg = await this.updateMessage(options.messageId, {
				body: options.text,
				isEdited: true
			});
			process.log("Mensagem atualizada no banco de dados.", updatedMsg);

			// Emite evento via socket para notificar os participantes do chat
			if (updatedMsg.internalChatId) {
				const room: SocketServerInternalChatRoom = `${session.instance}:internal-chat:${updatedMsg.internalChatId}`;

				// Notifica sobre a edição da mensagem
				socketService.emit(SocketEventType.InternalMessageEdit, room, {
					chatId: updatedMsg.internalChatId,
					internalMessageId: updatedMsg.id,
					newText: updatedMsg.body
				});
				process.log("Notificação via socket enviada.", room);
			} else {
				process.log("A mensagem não pertence a um chat interno, pulando notificação via socket.");
			}

			process.success("Mensagem interna editada com sucesso.");
			return updatedMsg;
		} catch (err) {
			process.log("Erro ao editar a mensagem interna.", (err as Error).message);
			process.failed(err);
			throw new Error("Failed to edit internal message: " + (err as Error).message);
		}
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
				lastReadAt: lastMsg?.timestamp ? new Date(+lastMsg.timestamp) : new Date()
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
		_sourceType: "whatsapp" | "internal",
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
			process.log(`Buscando ${originalMessages.length} mensagem(ns) original(is) do WhatsApp.`);

			if (originalMessages.length === 0) {
				process.log("Nenhuma mensagem original encontrada no DB. Encerrando.");
				return;
			}

			for (const chatId of internalTargetChatIds) {
				for (const originalMsg of originalMessages) {
					const messageBody = originalMsg.body;

					const messageData: Prisma.InternalMessageCreateInput = {
						instance: session.instance,
						from: `user:${session.userId}`,
						type: originalMsg.type,
						body: messageBody,
						timestamp: Date.now().toString(),
						status: "RECEIVED",
						isForwarded: true,
						isEdited: false,
						chat: {
							connect: { id: chatId }
						},
						fileId: originalMsg.fileId,
						fileName: originalMsg.fileName,
						fileType: originalMsg.fileType,
						fileSize: originalMsg.fileSize
					};

					const savedInternalMsg = await prismaService.internalMessage.create({
						data: messageData
					});

					process.log(
						`Mensagem ID:${originalMsg.id} encaminhada para Chat Interno ID:${chatId}. Nova msg ID:${savedInternalMsg.id}`
					);

					const room: SocketServerInternalChatRoom = `${session.instance}:internal-chat:${chatId}`;
					await socketService.emit(SocketEventType.InternalMessage, room, {
						message: savedInternalMsg
					});
				}
			}
			process.success("Todas as mensagens foram processadas para os chats internos.");
		} catch (err) {
			const msg = sanitizeErrorMessage(err) || "null";
			process.failed(`Erro ao encaminhar mensagens para chats internos: ${msg}`);
			throw new BadRequestError(`Erro ao encaminhar para chat interno: ${msg}`);
		}
	}

}

const internalChatsServiceInstance = new InternalChatsService();

export default internalChatsServiceInstance;
