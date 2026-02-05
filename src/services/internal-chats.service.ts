import {
	FileDirType,
	InternalChatMember,
	InternalMessage,
	SessionData,
	SocketEventType,
	SocketServerInternalChatRoom,
	SocketServerUserRoom,
	User
} from "@in.pulse-crm/sdk";
import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { InternalChat, Prisma } from "@prisma/client";
import { BadRequestError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";
import { Mention, SendFileOptions, SendMessageOptions } from "../types/whatsapp-instance.types";
import ProcessingLogger from "../utils/processing-logger";
import WhatsappAudioConverter from "../utils/whatsapp-audio-converter";
import WWEBJSWhatsappClient from "../whatsapp-client/wwebjs-whatsapp-client";
import filesService from "./files.service";
import instancesService from "./instances.service";
import prismaService from "./prisma.service";
import socketService from "./socket.service";
import whatsappService, { getMessageType } from "./whatsapp.service";
import internalMessageQueueService from "./internal-message-queue.service";

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

	// Envia uma mensagem no chat interno
	public async sendMessage(session: SessionData, data: InternalSendMessageData) {
		const { file, ...logData } = data;

		const process = new ProcessingLogger(
			session.instance,
			"internal-message",
			`${data.chatId}-${Date.now()}`,
			logData
		);

		process.log(
			`Iniciando envio de mensagem interna. Usuário: ${session.userId} (${session.name}), Chat ID: ${data.chatId}`
		);
		process.log(
			`Dados da requisição - Tipo de mensagem: ${data.sendAsAudio ? "áudio" : data.sendAsDocument ? "documento" : "texto"}, Com arquivo: ${!!file}, Com citação: ${!!data.quotedId}, Menções: ${data.mentions?.length || 0}`
		);

		try {
			let mentionsText = "";

			if (data.mentions?.length) {
				process.log(`Processando ${data.mentions.length} menção(ões)`);
				let mentions = data.mentions;

				if (typeof mentions === "string") {
					try {
						process.log(`Menções em formato string, parseando JSON`);
						mentions = JSON.parse(mentions);
					} catch (err) {
						process.log(`Erro ao fazer parse de menções: ${sanitizeErrorMessage(err)}`);
						throw new BadRequestError("mentions não é um JSON válido");
					}
				}

				if (!Array.isArray(mentions)) {
					process.log(`Menções não é um array`);
					throw new BadRequestError("mentions precisa ser um array");
				}

				process.log(`Validando telefones nas menções`);
				mentions
					.map((user) => {
						const phone = user.phone?.replace(/\D/g, "");
						if (!phone) {
							process.log(`Aviso: Telefone inválido em menção de usuário: ${user.name}`);
							return null;
						}
						return `${phone}@c.us`;
					})
					.filter((id): id is string => id !== null);

				mentionsText = mentions.map((user) => `@${user.name || user.phone}`).join(" ");
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

				if (data.sendAsAudio) {
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
					dirType: FileDirType.PUBLIC
				});

				process.log(
					`Arquivo enviado com sucesso. File ID: ${file.id}, Nome: ${file.name}, Tamanho: ${file.size} bytes`
				);

				message.fileId = file.id;
				message.fileName = file.name;
				message.fileType = file.mime_type;
				message.fileSize = String(file.size);
				message.type = getMessageType(file.mime_type, !!data.sendAsAudio, !!data.sendAsDocument);
			}

			process.log(`Salvando mensagem no banco de dados do chat ID: ${data.chatId}`);
			const savedMsg = await prismaService.internalMessage.create({
				data: message
			});
			process.log(
				`Mensagem salva com sucesso. ID da mensagem: ${savedMsg.id}, Tipo: ${savedMsg.type}, Status: ${savedMsg.status}`
			);

			if (data.mentions?.length) {
				process.log(`Processando ${data.mentions.length} menção(ões)`);
				const mentionsParsed =
					typeof data.mentions === "string" ? JSON.parse(data.mentions) : data.mentions || [];

				const mentionData = mentionsParsed.map((mention: any) => ({
					userId: typeof mention === "object" ? (mention.userId ?? mention.id) : mention,
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

			process.log(`Buscando informações do chat interno ID: ${data.chatId}`);
			const chat = await prismaService.internalChat.findUnique({
				where: { id: +data.chatId }
			});

			if (chat?.wppGroupId) {
				process.log(
					`Chat está associado a um grupo WhatsApp. Tentando enviar para grupo ID: ${chat.wppGroupId}`
				);


				try {
					const sentMsg = await this.sendMessageToWppGroup(session, chat.wppGroupId, data, savedMsg);

					process.log(
						`Resultado do envio - wwebjsId: ${sentMsg?.wwebjsId || "null"}, wwebjsIdStanza: ${sentMsg?.wwebjsIdStanza || "null"}, sentMsg completo:`,
						sentMsg
					);

					if (sentMsg?.wwebjsId || sentMsg?.wwebjsIdStanza) {
						process.log(
							`Mensagem enviada para WhatsApp com sucesso. wwebjsId: ${sentMsg.wwebjsId || "N/A"}, wwebjsIdStanza: ${sentMsg.wwebjsIdStanza || "N/A"}`
						);
						await prismaService.internalMessage.update({
							where: { id: savedMsg.id },
							data: {
								wwebjsIdStanza: sentMsg.wwebjsIdStanza ?? null,
								wwebjsId: sentMsg.wwebjsId ?? null,
								status: "RECEIVED"
							}
						});
						process.log(`Mensagem interna atualizada com IDs do WhatsApp`);
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
					await prismaService.internalMessage.update({
						where: { id: savedMsg.id },
						data: { status: "ERROR" }
					});
					throw err;
				}
			} else {
				await prismaService.internalMessage.update({
					where: { id: savedMsg.id },
					data: { status: "RECEIVED" }
				});
				process.log(`Chat é apenas interno, não há grupo WhatsApp associado`);
			}

			process.success("Mensagem enviada com sucesso.");
		} catch (err) {
			const msg = sanitizeErrorMessage(err) || "null";
			process.log(`Erro durante envio de mensagem: ${msg}`);
			process.log(`Stack trace: ${(err as Error).stack}`);
			process.failed(err);
			throw new BadRequestError("Erro ao enviar mensagem " + msg);
		}
	}

	public async receiveMessage(instance: string, groupId: string, msg: CreateMessageDto, authorName: string | null = null) {
		Logger.debug(`Recebendo mensagem de grupo WhatsApp. Grupo ID: ${groupId}, Autor: ${authorName || msg.from}`, msg);
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
				where: {
					instance: instance,
					wppGroupId: groupId
				}
			});
			/*  */
			if (!chat) {
				process.log(`Chat interno não encontrado para grupo ${groupId}. Ignorando mensagem.`);
				return;
			}
			process.log(`Chat interno encontrado. Chat ID: ${chat.id}`);

			const { to, clientId, sentAt, ...rest } = msg;
			process.log(`Salvando mensagem no banco de dados. Tipo: ${msg.type}, De: ${msg.from}`, {
				...rest,
				from: `external:${msg.from}` + (authorName ? `:${authorName}` : ""),
				internalChatId: chat.id,
				isForwarded: !!msg.isForwarded,
				isEdited: false
			});


			const savedMsg = await prismaService.internalMessage.create({
				data: {
					...rest,
					from: `external:${msg.from}` + (authorName ? `:${authorName}` : ""),
					isForwarded: !!msg.isForwarded,
					isEdited: false,
					chat: {
						connect: {
							id: chat.id
						}
					},
					...(clientId ? { client: { connect: { id: clientId } } } : {})
				},

			});

			process.log(`Mensagem salva com sucesso. Mensagem ID: ${savedMsg.id}`);

			const room = `${msg.instance}:internal-chat:${chat.id}` as SocketServerInternalChatRoom;
			process.log(`Emitindo evento de mensagem via socket para sala: ${room}`);
			await socketService.emit(SocketEventType.InternalMessage, room, {
				message: savedMsg
			});
			process.success(`Mensagem recebida e processada com sucesso`);

			return savedMsg;
		} catch (err) {
			const errorMsg = sanitizeErrorMessage(err) || "Erro desconhecido";
			process.log(`Erro ao receber mensagem: ${errorMsg}`);
			process.failed(err);
			throw err;
		}
	}

	/**
	 * Método chamado pela fila de processamento para processar uma mensagem interna
	 * Este método é injetado no internalMessageQueueService através do setProcessHandler
	 */
	public async processInternalMessageFromQueue(
		instance: string,
		_internalChatId: number,
		_queueId: string,
		groupId: string,
		messageData: CreateMessageDto,
		authorName?: string | null
	): Promise<void> {
		// Processa a mensagem normalmente usando o método receiveMessage
		await this.receiveMessage(instance, groupId, messageData, authorName);
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

			const chat = await prismaService.internalChat.findUnique({
				where: {
					wppGroupId: groupId
				}
			});

			if (!chat) {
				process.log(`Chat interno não encontrado para grupo ${groupId}. Ignorando edição.`);
				return;
			}
			process.log(`Chat interno encontrado. Chat ID: ${chat.id}`);

			process.log(`Buscando mensagem interna com stanza ID: ${msgId}`);
			const message = await prismaService.internalMessage.findFirst({
				where: {
					internalChatId: chat.id,
					wwebjsIdStanza: msgId
				}
			});

			if (!message) {
				process.log(`Mensagem não encontrada. Ignorando edição.`);
				return;
			}
			process.log(
				`Mensagem encontrada. Mensagem ID: ${message.id}, Texto anterior: "${message.body.substring(0, 50)}${message.body.length > 50 ? "..." : ""}"`
			);

			process.log(`Atualizando mensagem com novo texto`);
			const updatedMsg = await this.updateMessage(message.id, {
				body: newText,
				isEdited: true
			});

			process.log(
				`Mensagem atualizada com sucesso. Novo texto: "${newText.substring(0, 50)}${newText.length > 50 ? "..." : ""}"`
			);

			const room: SocketServerInternalChatRoom = `${chat.instance}:internal-chat:${chat.id}`;
			process.log(`Emitindo evento de edição via socket para sala: ${room}`);
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

			process.log(`Buscando setor padrão do usuário. Setor ID: ${session.sectorId}`);
			const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });

			if (!sector || !sector.defaultClientId) {
				const errorMsg = "Nenhum cliente WhatsApp padrão configurado para o setor do usuário.";
				process.log(`Erro: ${errorMsg}`);
				throw new BadRequestError(errorMsg);
			}
			process.log(`Setor encontrado. Cliente padrão ID: ${sector.defaultClientId}`);

			process.log(`Obtendo instância do cliente WhatsApp`);
			const client = whatsappService.getClient(sector.defaultClientId);

			if (!client) {
				process.log(`Aviso: Cliente WhatsApp não disponível. Encerrando sem erro.`);
				return;
			}
			process.log(`Cliente WhatsApp obtido com sucesso`);

			let waMentions: Mention[] = [];
			if (data.mentions) {
				process.log(`Processando menções para o grupo WhatsApp`);
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
			process.log(`Texto da mensagem formatado: "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}"`);

			if (data.quotedId) {
				process.log(`Processando resposta para mensagem ID: ${data.quotedId}`);
				const quotedmsg = await prismaService.internalMessage.findUnique({
					where: { id: +data.quotedId }
				});

				if (quotedmsg?.wwebjsId) {
					process.log(`Mensagem citada encontrada. wwebjsId: ${quotedmsg.wwebjsId}`);
					data.quotedId = quotedmsg.wwebjsId;
				} else {
					process.log(`Aviso: Mensagem citada não possui wwebjsId. Enviando sem resposta.`);
					data.quotedId = null;
				}
			}

			if (groupId && client && message.fileId && message.fileName) {
				process.log(`Enviando mensagem com arquivo. Arquivo ID: ${message.fileId}, Nome: ${message.fileName}`);
				const fileUrl = filesService.getFileDownloadUrl(message.fileId);
				process.log(`URL do arquivo gerada: ${fileUrl}`);

				process.log(`Enviando mensagem com arquivo para grupo ${groupId}`);
				const result = await client.sendMessage(
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
				process.log(
					`Mensagem com arquivo enviada. Resultado completo:`,
					result
				);
				process.log(
					`wwebjsId: ${result?.wwebjsId || "N/A"}, wwebjsIdStanza: ${result?.wwebjsIdStanza || "N/A"}`
				);
				process.success(`Mensagem com arquivo enviada para grupo ${groupId}`);
				return result;
			} else if (groupId && client) {
				process.log(`Enviando mensagem de texto para grupo ${groupId} (sem arquivo)`);
				const result = await client.sendMessage(
					{
						to: groupId,
						quotedId: data.quotedId || null,
						text,
						mentions: waMentions
					},
					true
				);
				process.log(
					`Mensagem de texto enviada. Resultado completo:`,
					result
				);
				process.log(
					`wwebjsId: ${result?.wwebjsId || "N/A"}, wwebjsIdStanza: ${result?.wwebjsIdStanza || "N/A"}`
				);
				process.success(`Mensagem de texto enviada para grupo ${groupId}`);
				return result;
			}

			process.log(`Cenário não esperado. Enviando mensagem com fallback`);
			const result = await client.sendMessage(
				{
					to: groupId,
					quotedId: data.quotedId || null,
					text: data.text,
					mentions: waMentions
				},
				true
			);
			process.log(`Mensagem enviada com sucesso (fallback). wwebjsId: ${result?.wwebjsId || "N/A"}`);
			process.success(`Mensagem enviada para grupo ${groupId}`);
			return result;
		} catch (err) {
			const errorMsg = sanitizeErrorMessage(err) || "Erro desconhecido";
			process.log(`Erro ao enviar mensagem para grupo: ${errorMsg}`);
			process.failed(err);
			throw err;
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

			// Se a mensagem pertence a um grupo do WhatsApp, edita lá também
			if (originalMsg.chat && originalMsg.chat?.wppGroupId && session.sectorId) {
				process.log("Mensagem pertence a um grupo do WhatsApp, tentando editar lá também.");
				const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });

				if (!sector || !sector.defaultClientId) {
					throw new BadRequestError("Nenhum cliente WhatsApp padrão configurado para o setor do usuário.");
				}
				const client = await whatsappService.getClient(sector.defaultClientId);

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

			const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });

			if (!sector || !sector.defaultClientId) {
				throw new BadRequestError("Nenhum cliente WhatsApp padrão configurado para o setor do usuário.");
			}
			const client = await whatsappService.getClient(sector.defaultClientId);

			if (!client) {
				throw new BadRequestError("Nenhum cliente WhatsApp encontrado para o setor especificado.");
			}

			for (const chatId of internalTargetChatIds) {
				const internalChat = await prismaService.internalChat.findUnique({
					where: { id: chatId },
					select: { isGroup: true, wppGroupId: true }
				});

				for (const originalMsg of originalMessages) {
					const phoneOrUserId = this.extractPhone(originalMsg.from);
					let userOrContact: any;

					if (originalMsg.from.startsWith("user:")) {
						const result = await instancesService.executeQuery<User>(
							session.instance,
							"SELECT * FROM operadores WHERE CODIGO = ?",
							[Number(phoneOrUserId)]
						);
						if (Array.isArray(result) && result.length > 0) {
							userOrContact = result[0];
						} else if (result && typeof result === "object") {
							userOrContact = result;
						} else {
							userOrContact = null;
						}
					} else if (originalMsg.from.startsWith("external:")) {
						if (phoneOrUserId) {
							userOrContact = await prismaService.wppContact.findFirst({
								where: { phone: phoneOrUserId }
							});
						} else {
							userOrContact = null;
						}
					}

					const messageBody = internalChat?.isGroup
						? `${userOrContact?.NOME || userOrContact?.name ? `*${userOrContact.NOME || userOrContact.name}*:` : ""} ${originalMsg.body}`
						: originalMsg.body;

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

					if (internalChat?.isGroup && internalChat.wppGroupId) {
						try {
							if (!(client instanceof WWEBJSWhatsappClient)) {
								process.log(
									`Cliente não suporta encaminhamento nativo para o grupo wppId:${internalChat.wppGroupId}`
								);
								continue;
							}

							if (sourceType === "internal") {
								const options: SendMessageOptions = {
									to: internalChat.wppGroupId,
									text: `_→ Encaminhada_\n${messageBody}`
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

								await client.sendMessage(options, true);
							} else {
								await client.forwardMessage(internalChat.wppGroupId, originalMsg.wwebjsId!, true);
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
			process.success("Todas as mensagens foram processadas para os chats internos.");
		} catch (err) {
			const msg = sanitizeErrorMessage(err) || "null";
			process.failed(`Erro ao encaminhar mensagens para chats internos: ${msg}`);
			throw new BadRequestError(`Erro ao encaminhar para chat interno: ${msg}`);
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

// Configura o handler de processamento da fila após a instância ser criada
internalMessageQueueService.setProcessHandler({
	processInternalMessage: internalChatsServiceInstance.processInternalMessageFromQueue.bind(internalChatsServiceInstance)
});

export default internalChatsServiceInstance;
