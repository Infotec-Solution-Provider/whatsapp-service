import "dotenv/config";
import {
	FileDirType,
	InternalChatMember,
	InternalMessage,
	SessionData,
	SocketEventType,
	SocketServerChatRoom,
	SocketServerInternalChatRoom,
	SocketServerUserRoom
} from "../sdk-local";
import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { InternalChat, Prisma } from "@prisma/client";
import { BadRequestError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";
import { Mention, SendMessageOptions } from "../types/whatsapp-instance.types";
import ProcessingLogger from "../utils/processing-logger";
import WhatsappAudioConverter from "../utils/whatsapp-audio-converter";
import filesService from "./files.service";
import prismaService from "./prisma.service";
import socketService from "./socket.service";
import whatsappService, { getMessageType } from "./whatsapp.service";
import { createUploadTraceLogger } from "../utils/file-upload-trace";
import getUsersClient from "./users.service";

const ENABLE_INTERNAL_GROUP_WHATSAPP_SYNC = process.env["ENABLE_INTERNAL_GROUP_WHATSAPP_SYNC"] === "true";

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
			let mentionsText = "";

			if (parsedMentions.length) {
				process.log(`Processando ${parsedMentions.length} menção(ões)`);

				process.log(`Validando telefones nas menções`);
				const validMentionPhones = parsedMentions
					.map((user) => {
						const phone = user.phone?.replace(/\D/g, "");
						if (!phone) {
							process.log(`Aviso: Telefone inválido em menção de usuário: ${user.name}`);
							return null;
						}
						return phone;
					})
					.filter((phone): phone is string => phone !== null);

				mentionsText = validMentionPhones.map((phone) => `@${phone}`).join(" ");
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

			if (parsedMentions.length) {
				process.log(`Persistindo ${parsedMentions.length} menção(ões)`);
				const mentionData = parsedMentions.map((mention) => ({
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

			const chatId = +data.chatId;

			if (ENABLE_INTERNAL_GROUP_WHATSAPP_SYNC) {
				process.log(`Buscando informações do chat interno ID: ${data.chatId}`);
				const chat = await prismaService.internalChat.findUnique({
					where: { id: chatId }
				});

				const initialStatus = chat?.wppGroupId ? "PENDING" : "SENT";
				process.log(
					`Emitindo evento de status inicial: ${initialStatus} para chat ${chat?.wppGroupId ? "com" : "sem"} vínculo WhatsApp`
				);
				await socketService.emit(SocketEventType.InternalMessageStatus, room, {
					chatId,
					internalMessageId: savedMsg.id,
					status: initialStatus
				});

				if (chat?.wppGroupId) {
					process.log(
						`Chat está associado a um grupo WhatsApp. Tentando enviar para grupo ID: ${chat.wppGroupId}`
					);
					try {
						trace.info("internal-message.forward-whatsapp.start", {
							wppGroupId: chat.wppGroupId,
							messageId: savedMsg.id
						});
						const sentMsg = await this.sendMessageToWppGroup(session, chat.wppGroupId, data, savedMsg);
						trace.info("internal-message.forward-whatsapp.success", {
							messageId: savedMsg.id,
							wwebjsId: sentMsg?.wwebjsId,
							wwebjsIdStanza: sentMsg?.wwebjsIdStanza
						});
						if (sentMsg?.wwebjsId || sentMsg?.wwebjsIdStanza) {
							process.log(
								`Mensagem enviada para WhatsApp com sucesso. wwebjsId: ${sentMsg.wwebjsId || "N/A"}, wwebjsIdStanza: ${sentMsg.wwebjsIdStanza || "N/A"}`
							);
							await prismaService.internalMessage.update({
								where: { id: savedMsg.id },
								data: { status: "RECEIVED" }
							});
							process.log(`Mensagem interna atualizada com status RECEIVED`);
							await socketService.emit(SocketEventType.InternalMessageStatus, room, {
								chatId,
								internalMessageId: savedMsg.id,
								status: "SENT"
							});
						} else {
							process.log(`Aviso: Mensagem não foi enviada para o WhatsApp ou não retornou nenhum ID`);
							await prismaService.internalMessage.update({
								where: { id: savedMsg.id },
								data: { status: "ERROR" }
							});
						}
					} catch (err) {
						const errorMsg = sanitizeErrorMessage(err) || "Erro desconhecido";
						process.log(`Falha ao enviar mensagem ao WhatsApp. Marcando como ERROR. Erro: ${errorMsg}`);
						trace.error("internal-message.forward-whatsapp.failed", err, {
							wppGroupId: chat.wppGroupId,
							messageId: savedMsg.id
						});
						await prismaService.internalMessage.update({
							where: { id: savedMsg.id },
							data: { status: "ERROR" }
						});
					}
				} else {
					await prismaService.internalMessage.update({
						where: { id: savedMsg.id },
						data: { status: "RECEIVED" }
					});
					process.log(`Chat é apenas interno, não há grupo WhatsApp associado`);
				}
			} else {
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
			}

			if (parsedMentions.length) {
				trace.info("internal-message.mentions-notification.start", {
					chatId,
					messageId: savedMsg.id,
					mentions: parsedMentions.length
				});

				try {
					await this.notifyMentionsViaWhatsapp(session, chatId, savedMsg, parsedMentions, process, authToken);
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

			// Se habilitado e a mensagem pertence a um grupo do WhatsApp, edita lá também
			if (ENABLE_INTERNAL_GROUP_WHATSAPP_SYNC && originalMsg.chat && originalMsg.chat?.wppGroupId && session.sectorId) {
				process.log("Mensagem pertence a um grupo do WhatsApp, tentando editar lá também.");
				const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });

				if (!sector || !sector.defaultClientId) {
					throw new BadRequestError("Nenhum cliente WhatsApp padrão configurado para o setor do usuário.");
				}
				const client = whatsappService.getClient(sector.defaultClientId);

				if (!client) {
					throw new BadRequestError("Nenhum cliente WhatsApp encontrado para o setor especificado.");
				}

				if (client && originalMsg.wwebjsId) {
					process.log("Editando mensagem no grupo do WhatsApp.");
					await client.editMessage({
						messageId: originalMsg.wwebjsId,
						text: options.text
					});
					process.log("Mensagem editada com sucesso no WhatsApp.");
				} else {
					process.log(
						"Cliente WhatsApp não disponível ou mensagem não possui wwebjsId, pulando edição no WhatsApp."
					);
				}
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
			process.log(`Buscando ${originalMessages.length} mensagem(ns) original(is) do WhatsApp.`);

			if (originalMessages.length === 0) {
				process.log("Nenhuma mensagem original encontrada no DB. Encerrando.");
				return;
			}

			let client: ReturnType<typeof whatsappService.getClient> | undefined;
			if (ENABLE_INTERNAL_GROUP_WHATSAPP_SYNC) {
				const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });
				if (sector?.defaultClientId) {
					client = whatsappService.getClient(sector.defaultClientId);
				}
			}

			for (const chatId of internalTargetChatIds) {
				const internalChat = ENABLE_INTERNAL_GROUP_WHATSAPP_SYNC
					? await prismaService.internalChat.findUnique({
						where: { id: chatId },
						select: { isGroup: true, wppGroupId: true }
					})
					: null;

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

					if (ENABLE_INTERNAL_GROUP_WHATSAPP_SYNC && internalChat?.isGroup && internalChat.wppGroupId && client) {
						try {
							if (sourceType === "internal") {
								let options: SendMessageOptions = {
									to: internalChat.wppGroupId,
									text: `_→ Encaminhada_\n${messageBody}`
								};

								if (originalMsg.fileId) {
									const fileData = await filesService.fetchFileMetadata(originalMsg.fileId);
									options = {
										...options,
										file: fileData,
										fileId: originalMsg.fileId,
										localFileUrl: filesService.getFileDownloadUrl(originalMsg.fileId),
										publicFileUrl: filesService.getPublicFileUrl(session.instance, fileData.public_id),
										sendAsAudio: false,
										sendAsDocument: false
									};
								}

								await client.sendMessage(options, true);
							} else {
								await client.forwardMessage(internalChat.wppGroupId, originalMsg.wwebjsId!, true);
							}
							process.log(
								`Mensagem ID:${originalMsg.id} também encaminhada para o grupo de WhatsApp ID:${internalChat.wppGroupId}`
							);
						} catch (err) {
							process.log(
								`Falha ao encaminhar msg ID:${originalMsg.id} para o grupo de WhatsApp ${internalChat.wppGroupId}: ${sanitizeErrorMessage(err)}`
							);
						}
					}
				}
			}
			process.success("Todas as mensagens foram processadas para os chats internos.");
		} catch (err) {
			const msg = sanitizeErrorMessage(err) || "null";
			process.failed(`Erro ao encaminhar mensagens para chats internos: ${msg}`);
			throw new BadRequestError(`Erro ao encaminhar para chat interno: ${msg}`);
		}
	}


	// ─── WhatsApp group sync ───────────────────────────────────────────────────

	private async resolveIncomingQuotedId(chatId: number, quotedId: unknown, process: ProcessingLogger) {
		if (quotedId == null) {
			return null;
		}

		if (typeof quotedId === "number" && Number.isInteger(quotedId)) {
			return quotedId;
		}

		if (typeof quotedId !== "string") {
			process.log(`quotedId recebido em formato inválido (${typeof quotedId}). Salvando mensagem sem referência.`);
			return null;
		}

		const normalizedQuotedId = quotedId.trim();

		if (!normalizedQuotedId) {
			return null;
		}

		const quotedMessage = await prismaService.internalMessage.findFirst({
			where: {
				internalChatId: chatId,
				OR: [{ wwebjsIdStanza: normalizedQuotedId }, { wwebjsId: normalizedQuotedId }]
			},
			select: { id: true }
		});

		if (!quotedMessage) {
			process.log(
				`Mensagem citada não encontrada para o identificador ${normalizedQuotedId}. Salvando mensagem sem quotedId.`
			);
			return null;
		}

		process.log(
			`Mensagem citada resolvida com sucesso. quotedId externo: ${normalizedQuotedId}, quotedId interno: ${quotedMessage.id}`
		);

		return quotedMessage.id;
	}

	public async receiveMessage(
		instance: string,
		groupId: string,
		msg: CreateMessageDto,
		authorName: string | null = null
	) {
		Logger.debug(
			`Recebendo mensagem de grupo WhatsApp. Grupo ID: ${groupId}, Autor: ${authorName || msg.from}`,
			msg
		);
		const cleanGroupId = groupId.replace(/[/:]/g, "-");
		const process = new ProcessingLogger(
			msg.instance,
			"receive-internal-message",
			`group_${cleanGroupId}_${Date.now()}`,
			{ groupId, from: msg.from, authorName }
		);

		try {
			process.log(`Recebendo mensagem de grupo WhatsApp. Grupo ID: ${groupId}, Autor: ${authorName || msg.from}`);

			const chat = await prismaService.internalChat.findUnique({
				where: { instance: instance, wppGroupId: groupId }
			});

			if (!chat) {
				process.log(`Chat interno não encontrado para grupo ${groupId}. Ignorando mensagem.`);
				return;
			}
			process.log(`Chat interno encontrado. Chat ID: ${chat.id}`);

			const resolvedQuotedId = await this.resolveIncomingQuotedId(chat.id, msg.quotedId, process);

			process.log(`Salvando mensagem no banco de dados. Tipo: ${msg.type}, De: ${msg.from}`);

			const savedMsg = await prismaService.internalMessage.create({
				data: {
					instance: msg.instance,
					from: `external:${msg.from}` + (authorName ? `:${authorName}` : ""),
					type: msg.type,
					body: msg.body,
					timestamp: msg.timestamp,
					status: "RECEIVED",
					quotedId: resolvedQuotedId,
					isForwarded: !!msg.isForwarded,
					isEdited: false,
					wwebjsId: msg.wwebjsId ?? null,
					wwebjsIdStanza: msg.wwebjsIdStanza ?? null,
					fileId: msg.fileId ?? null,
					fileName: msg.fileName ?? null,
					fileType: msg.fileType ?? null,
					fileSize: msg.fileSize ?? null,
					chat: { connect: { id: chat.id } },
					...(msg.clientId ? { client: { connect: { id: msg.clientId } } } : {})
				}
			});

			process.log(`Mensagem salva com sucesso. Mensagem ID: ${savedMsg.id}`);

			const room = `${msg.instance}:internal-chat:${chat.id}` as SocketServerInternalChatRoom;
			await socketService.emit(SocketEventType.InternalMessage, room, { message: savedMsg });
			process.success(`Mensagem recebida e processada com sucesso`);

			return savedMsg;
		} catch (err) {
			const errorMsg = sanitizeErrorMessage(err) || "Erro desconhecido";
			process.log(`Erro ao receber mensagem: ${errorMsg}`);
			process.failed(err);
			throw err;
		}
	}

	public async receiveMessageEdit(groupId: string, msgId: string, newText: string) {
		const cleanGroupId = groupId.replace(/[/:]/g, "-");
		const cleanMsgId = msgId.replace(/[/:]/g, "-");
		const process = new ProcessingLogger(
			"internal-service",
			"receive-message-edit",
			`group_${cleanGroupId}_msg_${cleanMsgId}`,
			{ groupId, messageId: msgId, textLength: newText.length }
		);

		try {
			process.log(
				`Recebendo edição de mensagem de grupo WhatsApp. Grupo ID: ${groupId}, Mensagem Stanza ID: ${msgId}`
			);

			const chat = await prismaService.internalChat.findUnique({ where: { wppGroupId: groupId } });

			if (!chat) {
				process.log(`Chat interno não encontrado para grupo ${groupId}. Ignorando edição.`);
				return;
			}
			process.log(`Chat interno encontrado. Chat ID: ${chat.id}`);

			const message = await prismaService.internalMessage.findFirst({
				where: { internalChatId: chat.id, wwebjsIdStanza: msgId }
			});

			if (!message) {
				process.log(`Mensagem não encontrada. Ignorando edição.`);
				return;
			}

			const updatedMsg = await this.updateMessage(message.id, { body: newText, isEdited: true });

			const room: SocketServerInternalChatRoom = `${chat.instance}:internal-chat:${chat.id}`;
			await socketService.emit(SocketEventType.InternalMessageEdit, room, {
				chatId: chat.id,
				internalMessageId: updatedMsg.id,
				newText: updatedMsg.body
			});

			process.success(`Edição de mensagem recebida e processada com sucesso`);
		} catch (err) {
			const errorMsg = sanitizeErrorMessage(err) || "Erro desconhecido";
			process.log(`Erro ao processar edição de mensagem: ${errorMsg}`);
			process.failed(err);
		}
	}

	public async receiveMessageReaction(groupId: string, msgId: string, reaction: string) {
		const chat = await prismaService.internalChat.findUnique({ where: { wppGroupId: groupId } });
		if (!chat) {
			return;
		}

		const message = await prismaService.internalMessage.findFirst({
			where: { internalChatId: chat.id, OR: [{ wwebjsIdStanza: msgId }, { wwebjsId: msgId }] }
		});
		if (!message) {
			return;
		}

		const room = `${chat.instance}:internal-chat:${chat.id}` as SocketServerInternalChatRoom;
		await socketService.emit(SocketEventType.WppMessageReaction, room as unknown as SocketServerChatRoom, {
			messageId: message.id,
			reaction
		});
	}

	public async receiveMessageRevoked(groupId: string, msgId: string) {
		const chat = await prismaService.internalChat.findUnique({ where: { wppGroupId: groupId } });
		if (!chat) {
			return;
		}

		const message = await prismaService.internalMessage.findFirst({
			where: { internalChatId: chat.id, OR: [{ wwebjsIdStanza: msgId }, { wwebjsId: msgId }] }
		});
		if (!message) {
			return;
		}

		await prismaService.internalMessage.update({
			where: { id: message.id },
			data: {
				body: "Mensagem apagada",
				status: "REVOKED",
				fileId: null,
				fileName: null,
				fileType: null,
				fileSize: null
			}
		});

		const room = `${chat.instance}:internal-chat:${chat.id}` as SocketServerInternalChatRoom;
		await socketService.emit(SocketEventType.InternalMessageDelete, room, {
			chatId: chat.id,
			internalMessageId: message.id
		});
	}

	private async persistGeneratedWppIds(
		messageId: number,
		sentMsg: CreateMessageDto | undefined,
		process: ProcessingLogger
	) {
		const dataToUpdate: Prisma.InternalMessageUpdateInput = {};

		if (sentMsg?.wwebjsId) {
			dataToUpdate.wwebjsId = sentMsg.wwebjsId;
		}

		if (sentMsg?.wwebjsIdStanza) {
			dataToUpdate.wwebjsIdStanza = sentMsg.wwebjsIdStanza;
		}

		if (!Object.keys(dataToUpdate).length) {
			process.log(`Nenhum ID do WhatsApp retornado para persistir na mensagem interna ${messageId}`);
			return;
		}

		await prismaService.internalMessage.update({ where: { id: messageId }, data: dataToUpdate });

		process.log(
			`IDs do WhatsApp persistidos na mensagem interna ${messageId}. wwebjsId: ${sentMsg?.wwebjsId || "N/A"}, wwebjsIdStanza: ${sentMsg?.wwebjsIdStanza || "N/A"}`
		);
	}

	public async sendMessageToWppGroup(
		session: SessionData,
		groupId: string,
		data: InternalSendMessageData,
		message: InternalMessage
	) {
		const cleanGroupId = groupId.replace(/[/:]/g, "-");
		const process = new ProcessingLogger(
			session.instance,
			"wpp-group-message",
			`group_${cleanGroupId}_${Date.now()}`,
			{ groupId, userId: session.userId, messageId: message.id }
		);

		try {
			process.log(
				`Iniciando envio de mensagem para grupo WhatsApp. Grupo ID: ${groupId}, Mensagem Interna ID: ${message.id}`
			);

			const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });

			if (!sector || !sector.defaultClientId) {
				const errorMsg = "Nenhum cliente WhatsApp padrão configurado para o setor do usuário.";
				process.log(`Erro: ${errorMsg}`);
				throw new BadRequestError(errorMsg);
			}

			const client = whatsappService.getClient(sector.defaultClientId);

			if (!client) {
				process.log(`Aviso: Cliente WhatsApp não disponível. Encerrando sem erro.`);
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
				process.log(`${waMentions.length} menção(ões) processada(s)`);
			}

			const text = `*${session.name}*: ${message.body}`;

			let resolvedQuotedId: string | null = null;
			if (data.quotedId) {
				const quotedmsg = await prismaService.internalMessage.findUnique({
					where: { id: +data.quotedId }
				});
				resolvedQuotedId = quotedmsg?.wwebjsIdStanza || quotedmsg?.wwebjsId || null;
				if (!resolvedQuotedId) {
					process.log(`Aviso: Mensagem citada não possui wwebjsId. Enviando sem resposta.`);
				}
			}

			if (message.fileId && message.fileName) {
				process.log(`Enviando mensagem com arquivo. Arquivo ID: ${message.fileId}`);
				const fileData = await filesService.fetchFileMetadata(message.fileId);
				const fileUrl = filesService.getFileDownloadUrl(message.fileId);
				const sendAsAudio = data.sendAsAudio === true || data.sendAsAudio === "true";
				const sendAsDocument = data.sendAsDocument === true || data.sendAsDocument === "true";

				const result = await client.sendMessage(
					{
						file: fileData,
						fileId: message.fileId,
						localFileUrl: fileUrl,
						publicFileUrl: filesService.getPublicFileUrl(session.instance, fileData.public_id),
						to: groupId,
						quotedId: resolvedQuotedId,
						sendAsAudio,
						sendAsDocument,
						text,
						mentions: waMentions
					},
					true
				);
				await this.persistGeneratedWppIds(message.id, result, process);
				process.success(`Mensagem com arquivo enviada para grupo ${groupId}`);
				return result;
			} else {
				const result = await client.sendMessage(
					{
						to: groupId,
						quotedId: resolvedQuotedId,
						text,
						mentions: waMentions
					},
					true
				);
				await this.persistGeneratedWppIds(message.id, result, process);
				process.success(`Mensagem de texto enviada para grupo ${groupId}`);
				return result;
			}
		} catch (err) {
			const errorMsg = sanitizeErrorMessage(err) || "Erro desconhecido";
			process.log(`Erro ao enviar mensagem para grupo: ${errorMsg}`);
			process.failed(err);
			throw err;
		}
	}

	extractPhone(from: string): string | null {
		if (from.startsWith("user:")) {
			return from.replace("user:", "");
		}

		if (from.startsWith("external:")) {
			return from.match(/:(\d+)@c\.us$/)?.[1] ?? null;
		}

		return null;
	}
}

const internalChatsServiceInstance = new InternalChatsService();

export default internalChatsServiceInstance;
