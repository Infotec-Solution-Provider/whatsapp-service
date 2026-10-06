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
import internalWhatsappSendersService from "./internal-whatsapp-senders.service";
import axios from "axios";
import internalWhatsappMessageQueueService, {
	InternalWhatsappQueueItem,
	InternalWhatsappQueuePayload,
	InternalWhatsappQueueProcessResult
} from "./internal-whatsapp-message-queue.service";
import parametersService from "./parameters.service";
import messagePresentationService from "./message-presentation.service";
import chatUserPreferencesService from "./chat-user-preferences.service";
import { messageMentionPatch, operatorMentionEntities } from "../utils/message-mention-persistence";
import { mentionMetadataToPrisma } from "../utils/message-mention-metadata";
import type { RemoteMessageJobResponse } from "../types/remote-client.types";
import {
	INTERNAL_WPP_MAX_RETRY_GENERATIONS,
	INTERNAL_WPP_RETRY_COOLDOWN_MS,
	InternalWppOutcome,
	WhatsappRetryHint,
	classifyInternalWppJob,
	internalWppIdempotencyKey,
	outcomeErrorPrefix,
	parseQueuePayload,
	remoteJobDiagnostics,
	whatsappRetryHint
} from "../utils/internal-wpp-send-outcome";
import opsAlerts from "./ops-alerts";

const LEGACY_INTERNAL_GROUP_WHATSAPP_SYNC_DEFAULT = process.env["ENABLE_INTERNAL_GROUP_WHATSAPP_SYNC"] === "true";

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

export type InternalWppRetryErrorCode = "CONFIRMATION_REQUIRED" | "NOT_RETRYABLE" | "RETRY_LIMIT" | "FORBIDDEN" | "NOT_FOUND";

/** Manual WhatsApp resend rejection; the controller returns `{ message, code }` with this status. */
export class InternalWppRetryError extends Error {
	constructor(
		public readonly statusCode: 403 | 404 | 409,
		public readonly code: InternalWppRetryErrorCode,
		message: string
	) {
		super(message);
		this.name = "InternalWppRetryError";
	}
}

const INTERNAL_WPP_SLOW_SEND_MS = Math.max(1000, Number(process.env["OPS_ALERTS_SLOW_SEND_MS"]) || 20_000);

const OUTCOME_SUMMARIES: Record<InternalWppOutcome["kind"], string> = {
	NOT_SENT: "Não enviada ao grupo (comprovadamente não saiu; reenvio seguro)",
	FAILED: "Falha no envio ao grupo",
	UNKNOWN: "Envio ao grupo sem confirmação (resultado incerto)"
};

function timeMs(value: unknown): number | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
	if (typeof value === "string" && value) {
		const parsed = new Date(value).getTime();
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

function isoOrNull(value: unknown): string | null {
	const ms = timeMs(value);
	return ms === null ? null : new Date(ms).toISOString();
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
	public async getInternalChatsBySession(session: SessionData, includeMessages = true) {
		const result = await prismaService.internalChat.findMany({
			where: {
				instance: session.instance,
				isFinished: false,
				participants: {
					some: { userId: session.userId }
				}
			},
			include: {
				participants: true
			}
		});

		const chatIds = result.map((chat) => chat.id);
		const preferences = await chatUserPreferencesService.getMap(session, chatIds, "internal");
		const messages: InternalMessage[] =
			includeMessages && chatIds.length
				? await prismaService.internalMessage.findMany({
						where: { instance: session.instance, internalChatId: { in: chatIds } }
					})
				: [];
		const lastMessageByChat = new Map<number, InternalMessage>();
		const latestInboundByChat = new Map<number, InternalMessage>();

		if (!includeMessages && chatIds.length) {
			const [lastGroups, latestInboundGroups] = await Promise.all([
				prismaService.internalMessage.groupBy({
					by: ["internalChatId"],
					where: { instance: session.instance, internalChatId: { in: chatIds } },
					_max: { id: true }
				}),
				prismaService.internalMessage.groupBy({
					by: ["internalChatId"],
					where: {
						instance: session.instance,
						internalChatId: { in: chatIds },
						from: { not: `user:${session.userId}` }
					},
					_max: { id: true }
				})
			]);
			const ids = new Set<number>();
			for (const group of [...lastGroups, ...latestInboundGroups]) {
				if (typeof group._max.id === "number") ids.add(group._max.id);
			}
			const summaryMessages = ids.size
				? await prismaService.internalMessage.findMany({ where: { id: { in: [...ids] } } })
				: [];
			const presentedSummaries = await messagePresentationService.hydrate(
				session.instance,
				summaryMessages,
				"internal"
			);
			const lastIds = new Set(lastGroups.map((group) => group._max.id));
			const inboundIds = new Set(latestInboundGroups.map((group) => group._max.id));
			for (const message of presentedSummaries) {
				if (lastIds.has(message.id)) lastMessageByChat.set(message.internalChatId, message);
				if (inboundIds.has(message.id)) latestInboundByChat.set(message.internalChatId, message);
			}
		}

		const chats = result.map((chat) => {
			const preference = preferences.get(`internal:${chat.id}`);
			if (includeMessages) {
				return {
					...chat,
					isPinned: preference?.isPinned ?? false,
					...(preference?.isMarkedUnread ? { isUnread: true } : {})
				};
			}
			const participant = chat.participants.find((item) => item.userId === session.userId);
			const latestInbound = latestInboundByChat.get(chat.id);
			const lastReadAt = participant?.lastReadAt?.getTime() ?? 0;
			const isUnread =
				(Boolean(latestInbound) && Number(latestInbound!.timestamp) > lastReadAt) ||
				Boolean(preference?.isMarkedUnread);

			return {
				...chat,
				lastMessage: lastMessageByChat.get(chat.id) || null,
				isUnread,
				isPinned: preference?.isPinned ?? false
			};
		}) as unknown as Array<
			InternalChat & {
				participants: InternalChatMember[];
				lastMessage?: InternalMessage | null;
				isUnread?: boolean;
			}
		>;

		return { chats, messages: await messagePresentationService.hydrate(session.instance, messages, "internal") };
	}

	public async getInternalChatMessagesPage(
		session: SessionData,
		chatId: number,
		limit: number,
		beforeId: number | null
	) {
		const chat = await prismaService.internalChat.findFirst({
			where: {
				id: chatId,
				instance: session.instance,
				participants: {
					some: { userId: session.userId }
				}
			},
			select: { id: true }
		});

		if (!chat) throw new BadRequestError("Internal chat not found!");

		const page = await prismaService.internalMessage.findMany({
			where: {
				instance: session.instance,
				internalChatId: chatId,
				...(beforeId ? { id: { lt: beforeId } } : {})
			},
			orderBy: { id: "desc" },
			take: limit + 1
		});
		const hasMore = page.length > limit;
		const messages = page.slice(0, limit).reverse();
		const quotedIds = messages
			.map((message) => message.quotedId)
			.filter((id): id is number => typeof id === "number");
		const quotedMessages = quotedIds.length
			? await prismaService.internalMessage.findMany({
					where: { id: { in: quotedIds }, instance: session.instance }
				})
			: [];

		return {
			messages: await messagePresentationService.hydrate(session.instance, messages, "internal"),
			quotedMessages: await messagePresentationService.hydrate(session.instance, quotedMessages, "internal"),
			nextCursor: hasMore && messages.length ? messages[0]!.id : null
		};
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

		return { chats, messages: await messagePresentationService.hydrate(session.instance, messages, "internal") };
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
			process.log(
				`Notificação de menções ignorada: token de autenticação ausente para resolver WHATSAPP dos operadores`
			);
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

		const process = new ProcessingLogger(session.instance, "internal-message", traceId, logData);

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
			sendAsDocument
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
				mentionMetadata: mentionMetadataToPrisma(operatorMentionEntities(parsedMentions)),
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
					fileType: data.file.mimetype
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
					traceId
				});
				trace.info("internal-message.file.upload.success", {
					fileId: file.id,
					fileName: file.name,
					fileSize: file.size,
					fileType: file.mime_type
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
			const [presentedMessage] = await messagePresentationService.hydrate(
				session.instance,
				[savedMsg],
				"internal"
			);
			await socketService.emit(SocketEventType.InternalMessage, room, {
				message: presentedMessage!
			});
			process.log(`Evento de socket emitido com sucesso`);

			const chatId = +data.chatId;

			if (
				await parametersService.isInternalGroupWhatsappSyncEnabled(
					session.instance,
					LEGACY_INTERNAL_GROUP_WHATSAPP_SYNC_DEFAULT
				)
			) {
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
						const queued = await this.enqueueMessageToWppGroup(session, chat.wppGroupId, data, savedMsg);
						if (queued) {
							process.log(`Mensagem ${savedMsg.id} persistida na fila assincrona do WhatsApp`);
							trace.info("internal-message.forward-whatsapp.queued", {
								wppGroupId: chat.wppGroupId,
								messageId: savedMsg.id
							});
						} else {
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
								await this.updateMessageStatusAndNotify(savedMsg.id, "RECEIVED");
								process.log(`Mensagem interna atualizada com status RECEIVED`);
							} else {
								process.log(
									`Aviso: Mensagem não foi enviada para o WhatsApp ou não retornou nenhum ID`
								);
								await this.updateMessageStatusAndNotify(savedMsg.id, "ERROR");
							}
						}
					} catch (err) {
						const errorMsg = sanitizeErrorMessage(err) || "Erro desconhecido";
						process.log(`Falha ao enviar mensagem ao WhatsApp. Marcando como ERROR. Erro: ${errorMsg}`);
						trace.error("internal-message.forward-whatsapp.failed", err, {
							wppGroupId: chat.wppGroupId,
							messageId: savedMsg.id
						});
						await this.updateMessageStatusAndNotify(savedMsg.id, "ERROR");
					}
				} else {
					await this.updateMessageStatusAndNotify(savedMsg.id, "RECEIVED");
					process.log(`Chat é apenas interno, não há grupo WhatsApp associado`);
				}
			} else {
				process.log(`Emitindo status inicial SENT para mensagem interna`);
				await socketService.emit(SocketEventType.InternalMessageStatus, room, {
					chatId,
					internalMessageId: savedMsg.id,
					status: "SENT"
				});

				await this.updateMessageStatusAndNotify(savedMsg.id, "RECEIVED");
				process.log(`Mensagem interna marcada como RECEIVED`);
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
				hasFile: !!data.file
			});
			const msg = sanitizeErrorMessage(err) || "null";
			process.log(`Erro durante envio de mensagem: ${msg}`);
			process.log(`Stack trace: ${(err as Error).stack}`);
			process.failed(err);
			throw new BadRequestError("Erro ao enviar mensagem " + msg);
		}
	}

	public async updateMessage(
		id: number,
		data: Omit<Partial<InternalMessage>, "mentionEntities"> & {
			mentionMetadata?: unknown;
			mentionEntities?: unknown;
		}
	) {
		const previous =
			data.body !== undefined
				? await prismaService.internalMessage.findUnique({ where: { id }, select: { body: true } })
				: null;
		const {
			mentionEntities: _entities,
			mentionMetadata: _metadata,
			reactions: _reactions,
			reactionsUpdatedAt: _reactionAt,
			...persistable
		} = data;
		return await prismaService.internalMessage.update({
			where: { id },
			data: { ...persistable, ...messageMentionPatch(data, previous ?? undefined) }
		});
	}

	public async getInternalMessageById(session: SessionData, id: number) {
		const message = await prismaService.internalMessage.findUnique({
			where: { id },
			include: {
				chat: true,
				client: { select: { type: true } }
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

			const hasExternalMessageId = Boolean(originalMsg.wwebjsIdStanza || originalMsg.wwebjsId);
			let whatsappEditResult: Record<string, unknown> = {
				attempted: false,
				reason: originalMsg.chat?.wppGroupId ? "missing-external-message-id" : "chat-not-linked-to-whatsapp"
			};

			// A existência do ID externo indica que esta mensagem foi efetivamente enviada ao WhatsApp.
			// Nesse caso, propague a edição mesmo quando a sincronização geral de grupos estiver desabilitada.
			if (originalMsg.chat?.wppGroupId && hasExternalMessageId) {
				const sector = originalMsg.clientId
					? null
					: await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });
				const clientId = originalMsg.clientId || sector?.defaultClientId;

				if (!clientId) {
					throw new BadRequestError("Não foi possível identificar o cliente WhatsApp que enviou a mensagem.");
				}

				const client = whatsappService.getClient(clientId);
				if (!client) {
					throw new BadRequestError(
						`Cliente WhatsApp ${clientId} não está disponível para editar a mensagem.`
					);
				}
				const clientType =
					originalMsg.client?.type ||
					(await prismaService.wppClient.findUnique({ where: { id: clientId }, select: { type: true } }))
						?.type;
				const preferSerializedId = clientType === "WWEBJS" && Boolean(originalMsg.wwebjsId);
				const externalMessageId = preferSerializedId
					? originalMsg.wwebjsId
					: originalMsg.wwebjsIdStanza || originalMsg.wwebjsId;
				const externalMessageIdSource =
					preferSerializedId || !originalMsg.wwebjsIdStanza ? "wwebjsId" : "wwebjsIdStanza";

				if (!externalMessageId) {
					throw new BadRequestError(
						"Mensagem não possui um identificador compatível com o cliente WhatsApp."
					);
				}

				process.log("Editando mensagem no grupo do WhatsApp.", {
					clientId,
					clientType,
					externalMessageId,
					idSource: externalMessageIdSource
				});
				await client.editMessage({ messageId: externalMessageId, text: options.text });
				whatsappEditResult = { attempted: true, status: "success", clientId, clientType, externalMessageId };
				process.log("Mensagem editada com sucesso no WhatsApp.", whatsappEditResult);
			} else {
				process.log("Edição no WhatsApp não aplicável para esta mensagem.", whatsappEditResult);
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
				const [presentedMessage] = await messagePresentationService.hydrate(
					session.instance,
					[updatedMsg],
					"internal"
				);

				// Notifica sobre a edição da mensagem
				socketService.emit(SocketEventType.InternalMessageEdit, room, {
					chatId: updatedMsg.internalChatId,
					internalMessageId: updatedMsg.id,
					newText: updatedMsg.body,
					...(presentedMessage?.mentionEntities !== undefined
						? { mentionEntities: presentedMessage.mentionEntities }
						: {})
				});
				process.log("Notificação via socket enviada.", room);
			} else {
				process.log("A mensagem não pertence a um chat interno, pulando notificação via socket.");
			}

			process.success({ message: "Mensagem interna editada com sucesso.", whatsappEdit: whatsappEditResult });
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
		await chatUserPreferencesService.markRead(
			{
				instance: (
					await prismaService.internalChat.findUniqueOrThrow({
						where: { id: chatId },
						select: { instance: true }
					})
				).instance,
				userId
			},
			"internal",
			chatId
		);
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

			const groupWhatsappSyncEnabled = await parametersService.isInternalGroupWhatsappSyncEnabled(
				session.instance,
				LEGACY_INTERNAL_GROUP_WHATSAPP_SYNC_DEFAULT
			);
			let client: ReturnType<typeof whatsappService.getClient> | undefined;
			if (groupWhatsappSyncEnabled) {
				const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });
				if (sector?.defaultClientId) {
					client = whatsappService.getClient(sector.defaultClientId);
				}
			}

			for (const chatId of internalTargetChatIds) {
				const internalChat = groupWhatsappSyncEnabled
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
						mentionMetadata: mentionMetadataToPrisma(
							originalMsg.mentionMetadata ?? originalMsg.mentionEntities
						),
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
					const [presentedMessage] = await messagePresentationService.hydrate(
						session.instance,
						[savedInternalMsg],
						"internal"
					);
					await socketService.emit(SocketEventType.InternalMessage, room, {
						message: presentedMessage!
					});

					if (groupWhatsappSyncEnabled && internalChat?.isGroup && internalChat.wppGroupId && client) {
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
										publicFileUrl: filesService.getPublicFileUrl(
											session.instance,
											fileData.public_id
										),
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
			process.log(
				`quotedId recebido em formato inválido (${typeof quotedId}). Salvando mensagem sem referência.`
			);
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
			const whatsappSender = await internalWhatsappSendersService.register(instance, msg.from, authorName);

			process.log(`Salvando mensagem no banco de dados. Tipo: ${msg.type}, De: ${msg.from}`);

			const savedMsg = await prismaService.internalMessage.create({
				data: {
					instance,
					from: `external:${msg.from}` + (whatsappSender.displayName ? `:${whatsappSender.displayName}` : ""),
					type: msg.type,
					body: msg.body,
					...messageMentionPatch(msg),
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
					whatsappSender: { connect: { id: whatsappSender.id } },
					...(msg.clientId ? { client: { connect: { id: msg.clientId } } } : {})
				}
			});

			process.log(`Mensagem salva com sucesso. Mensagem ID: ${savedMsg.id}`);

			const room = `${instance}:internal-chat:${chat.id}` as SocketServerInternalChatRoom;
			const [presentedMessage] = await messagePresentationService.hydrate(instance, [savedMsg], "internal");
			await socketService.emit(SocketEventType.InternalMessage, room, { message: presentedMessage! });
			process.success(`Mensagem recebida e processada com sucesso`);

			return savedMsg;
		} catch (err) {
			const errorMsg = sanitizeErrorMessage(err) || "Erro desconhecido";
			process.log(`Erro ao receber mensagem: ${errorMsg}`);
			process.failed(err);
			throw err;
		}
	}

	public async receiveMessageEdit(
		groupId: string,
		msgId: string,
		newText: string,
		options: { mentionEntities?: unknown; instance?: string; clientId?: number } = {}
	) {
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

			const chat = await prismaService.internalChat.findFirst({
				where: {
					wppGroupId: groupId,
					...(options.instance !== undefined ? { instance: options.instance } : {})
				}
			});

			if (!chat) {
				process.log(`Chat interno não encontrado para grupo ${groupId}. Ignorando edição.`);
				return;
			}
			process.log(`Chat interno encontrado. Chat ID: ${chat.id}`);

			const message = await prismaService.internalMessage.findFirst({
				where: {
					instance: chat.instance,
					internalChatId: chat.id,
					...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
					OR: [{ wwebjsIdStanza: msgId }, { wwebjsId: msgId }]
				}
			});

			if (!message) {
				process.log(`Mensagem não encontrada. Ignorando edição.`);
				return;
			}

			const updatedMsg = await this.updateMessage(message.id, {
				body: newText,
				isEdited: true,
				...(options.mentionEntities !== undefined ? { mentionEntities: options.mentionEntities } : {})
			});
			const [presentedMessage] = await messagePresentationService.hydrate(
				chat.instance,
				[updatedMsg],
				"internal"
			);

			const room: SocketServerInternalChatRoom = `${chat.instance}:internal-chat:${chat.id}`;
			await socketService.emit(SocketEventType.InternalMessageEdit, room, {
				chatId: chat.id,
				internalMessageId: updatedMsg.id,
				newText: updatedMsg.body,
				...(presentedMessage?.mentionEntities !== undefined
					? { mentionEntities: presentedMessage.mentionEntities }
					: {})
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
			messageType: "internal",
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
		process: ProcessingLogger,
		clientId?: number
	) {
		const dataToUpdate: Prisma.InternalMessageUpdateInput = {};

		if (sentMsg?.wwebjsId) {
			dataToUpdate.wwebjsId = sentMsg.wwebjsId;
		}

		if (sentMsg?.wwebjsIdStanza) {
			dataToUpdate.wwebjsIdStanza = sentMsg.wwebjsIdStanza;
		}

		const resolvedClientId = clientId || sentMsg?.clientId;
		if (resolvedClientId) {
			dataToUpdate.client = { connect: { id: resolvedClientId } };
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

	private async enqueueMessageToWppGroup(
		session: SessionData,
		groupId: string,
		data: InternalSendMessageData,
		message: InternalMessage
	): Promise<boolean> {
		const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });
		if (!sector?.defaultClientId) {
			throw new BadRequestError("Nenhum cliente WhatsApp padrÃ£o configurado para o setor do usuÃ¡rio.");
		}

		const client = whatsappService.getClient(sector.defaultClientId);
		if (!client?.submitMessageJob || !client.getMessageJob) return false;

		const payload: InternalWhatsappQueuePayload = {
			clientId: sector.defaultClientId,
			session: {
				userId: session.userId,
				sectorId: session.sectorId,
				role: session.role,
				instance: session.instance,
				name: session.name
			},
			data: {
				sendAsAudio: data.sendAsAudio === true || data.sendAsAudio === "true",
				sendAsDocument: data.sendAsDocument === true || data.sendAsDocument === "true",
				...(data.quotedId !== undefined ? { quotedId: data.quotedId } : {}),
				...(data.mentions !== undefined ? { mentions: data.mentions } : {})
			}
		};

		await internalWhatsappMessageQueueService.enqueue({
			instance: session.instance,
			internalChatId: message.internalChatId,
			internalMessageId: message.id,
			groupId,
			authorName: session.name,
			payload
		});
		return true;
	}

	private async buildQueuedWppGroupMessageOptions(
		session: SessionData,
		groupId: string,
		data: InternalSendMessageData,
		message: InternalMessage,
		process: ProcessingLogger
	): Promise<SendMessageOptions> {
		let waMentions: Mention[] = [];
		if (data.mentions) {
			const mentions =
				typeof data.mentions === "string" ? (JSON.parse(data.mentions) as Mention[]) : data.mentions;
			waMentions = mentions.map((mention) => ({
				userId: mention.userId ?? 0,
				phone: mention.phone ?? "",
				name: mention.name || mention.phone || ""
			}));
		}

		let resolvedQuotedId: string | null = null;
		if (data.quotedId) {
			const quotedMessage = await prismaService.internalMessage.findUnique({
				where: { id: Number(data.quotedId) }
			});
			resolvedQuotedId = quotedMessage?.wwebjsIdStanza || quotedMessage?.wwebjsId || null;
		}

		const text = `*${session.name}*: ${message.body}`;
		if (!message.fileId || !message.fileName) {
			return { to: groupId, quotedId: resolvedQuotedId, text, mentions: waMentions };
		}

		process.log(`Carregando metadados do arquivo ${message.fileId} para o job assÃ­ncrono`);
		const file = await filesService.fetchFileMetadata(message.fileId);
		return {
			file,
			fileId: message.fileId,
			localFileUrl: filesService.getFileDownloadUrl(message.fileId),
			publicFileUrl: filesService.getPublicFileUrl(session.instance, file.public_id),
			to: groupId,
			quotedId: resolvedQuotedId,
			sendAsAudio: data.sendAsAudio === true || data.sendAsAudio === "true",
			sendAsDocument: data.sendAsDocument === true || data.sendAsDocument === "true",
			text,
			mentions: waMentions
		};
	}

	private async updateMessageStatusAndNotify(
		messageId: number,
		status: InternalMessage["status"],
		whatsappRetry?: WhatsappRetryHint | null
	): Promise<void> {
		const message = await prismaService.internalMessage.update({
			where: { id: messageId },
			data: { status }
		});
		await this.emitMessageStatus(message, whatsappRetry);
	}

	/** Publishes the persisted status (and the ERROR retry hint) to the chat room. */
	private async emitMessageStatus(
		message: Pick<InternalMessage, "id" | "instance" | "internalChatId" | "status">,
		whatsappRetry?: WhatsappRetryHint | null
	): Promise<void> {
		const hint =
			message.status === "ERROR"
				? whatsappRetry !== undefined
					? whatsappRetry
					: await this.resolveWhatsappRetryHint(message)
				: null;
		// Publish the persisted value so live messages match a history reload.
		const room = `${message.instance}:internal-chat:${message.internalChatId}` as SocketServerInternalChatRoom;
		await socketService.emit(SocketEventType.InternalMessageStatus, room, {
			chatId: message.internalChatId,
			internalMessageId: message.id,
			status: message.status,
			...(hint ? { whatsappRetry: hint } : {})
		});
	}

	/** Outcome-only hint (socket rooms are shared); author/admin is enforced by the retry endpoint. */
	private async resolveWhatsappRetryHint(message: {
		id: number;
		internalChatId: number;
	}): Promise<WhatsappRetryHint | null> {
		try {
			const chat = await prismaService.internalChat.findUnique({
				where: { id: message.internalChatId },
				select: { wppGroupId: true }
			});
			if (!chat?.wppGroupId) return null;
			const row = await prismaService.internalMessageProcessingQueue.findFirst({
				where: { internalMessageId: message.id },
				select: { messageData: true }
			});
			const payload = parseQueuePayload<InternalWhatsappQueuePayload>(row?.messageData);
			return whatsappRetryHint({
				exists: !!row,
				retryGeneration: payload?.retryGeneration,
				outcome: payload?.outcome
			});
		} catch (error) {
			Logger.error(
				`[internal-wpp-send] retry hint unavailable for message ${message.id}: ${error instanceof Error ? error.message : String(error)}`
			);
			return null;
		}
	}

	/** Start of the current delivery generation (a manual resend restarts the clock). */
	private queuedWppStartedAt(item: InternalWhatsappQueueItem, payload: InternalWhatsappQueuePayload): number {
		return timeMs(payload.lastRetryAt) ?? timeMs(item.createdAt) ?? Date.now();
	}

	private queuedWppLogEntry(
		item: InternalWhatsappQueueItem,
		payload: InternalWhatsappQueuePayload,
		job: RemoteMessageJobResponse | null,
		status: string,
		totalMs: number
	) {
		const remote = remoteJobDiagnostics(job);
		return {
			queueId: item.id,
			internalMessageId: item.internalMessageId,
			instance: item.instance,
			clientId: payload.clientId,
			jobId: job?.jobId ?? payload.remoteJobId ?? null,
			retryGeneration: payload.retryGeneration ?? 0,
			status,
			outcome: payload.outcome?.kind ?? null,
			createdAt: isoOrNull(item.createdAt),
			firstClaimAt: payload.timing?.firstClaimAt ?? null,
			completedAt: payload.timing?.completedAt ?? null,
			totalMs,
			remote: {
				firstAttemptAt: remote.firstAttemptAt,
				processedAt: remote.processedAt,
				sendDurationMs: remote.sendDurationMs,
				sendSessionId: remote.sendSessionId,
				sendLibrary: remote.sendLibrary,
				fallback: remote.fallback,
				failureKind: remote.failureKind
			}
		};
	}

	private emitQueuedWppAlert(
		type: "SEND_FAILED" | "SEND_SLOW",
		item: InternalWhatsappQueueItem,
		payload: InternalWhatsappQueuePayload,
		job: RemoteMessageJobResponse | null,
		summary: string,
		totalMs: number
	): void {
		const remote = remoteJobDiagnostics(job);
		opsAlerts.emit({
			type,
			severity: type === "SEND_FAILED" ? "high" : "warn",
			instance: item.instance,
			clientId: payload.clientId,
			sessionId: remote.sendSessionId ?? undefined,
			summary,
			refs: {
				internalMessageId: item.internalMessageId ?? undefined,
				queueId: item.id,
				jobId: job?.jobId ?? payload.remoteJobId,
				library: remote.sendLibrary,
				fallback: remote.fallback,
				durationMs: totalMs,
				firstAttemptAt: remote.firstAttemptAt ?? payload.timing?.firstClaimAt ?? null,
				outcome: payload.outcome?.kind
			}
		});
	}

	/** Still in flight: persists timing only on the first slow detection (never on every poll). */
	private pendingQueuedWppMessage(
		item: InternalWhatsappQueueItem,
		payload: InternalWhatsappQueuePayload,
		timing: NonNullable<InternalWhatsappQueuePayload["timing"]>,
		job: RemoteMessageJobResponse,
		verifying: boolean
	): InternalWhatsappQueueProcessResult {
		const elapsed = Date.now() - this.queuedWppStartedAt(item, payload);
		if (elapsed <= INTERNAL_WPP_SLOW_SEND_MS || timing.slowAlertedAt) return { status: "PENDING" };

		timing.slowAlertedAt = new Date().toISOString();
		payload.timing = timing;
		Logger.info(
			`[internal-wpp-send] slow ${JSON.stringify(this.queuedWppLogEntry(item, payload, job, job.status, elapsed))}`
		);
		this.emitQueuedWppAlert(
			"SEND_SLOW",
			item,
			payload,
			job,
			verifying ? "Aguardando confirmação do WhatsApp" : "Envio ainda em andamento",
			elapsed
		);
		return { status: "PENDING", messageData: JSON.stringify(payload) };
	}

	private completeQueuedWppMessage(
		item: InternalWhatsappQueueItem,
		payload: InternalWhatsappQueuePayload,
		timing: NonNullable<InternalWhatsappQueuePayload["timing"]>,
		job: RemoteMessageJobResponse
	): InternalWhatsappQueueProcessResult {
		const completedAt = new Date();
		const totalMs = completedAt.getTime() - this.queuedWppStartedAt(item, payload);
		timing.completedAt = completedAt.toISOString();
		const slow = totalMs > INTERNAL_WPP_SLOW_SEND_MS && !timing.slowAlertedAt;
		if (slow) timing.slowAlertedAt = timing.completedAt;
		payload.timing = timing;
		const entry = JSON.stringify(this.queuedWppLogEntry(item, payload, job, "RECEIVED", totalMs));
		// A send that turned slow between two polls still gets its single `slow` line.
		if (slow) Logger.info(`[internal-wpp-send] slow ${entry}`);
		Logger.info(`[internal-wpp-send] ${entry}`);
		if (slow) this.emitQueuedWppAlert("SEND_SLOW", item, payload, job, "Entregue ao grupo com atraso", totalMs);
		return { status: "COMPLETED", messageData: JSON.stringify(payload) };
	}

	/** Terminal failure: internal status ERROR with a retry hint, outcome persisted with the queue status. */
	private async finishQueuedWppError(
		item: InternalWhatsappQueueItem,
		payload: InternalWhatsappQueuePayload,
		timing: NonNullable<InternalWhatsappQueuePayload["timing"]>,
		job: RemoteMessageJobResponse | null,
		kind: InternalWppOutcome["kind"],
		queueStatus: "FAILED" | "UNKNOWN",
		error: string
	): Promise<InternalWhatsappQueueProcessResult> {
		const completedAt = new Date();
		const outcome: InternalWppOutcome = {
			kind,
			safeToResend: kind === "NOT_SENT",
			at: completedAt.toISOString(),
			error: error.slice(0, 500)
		};
		payload.outcome = outcome;
		timing.completedAt = completedAt.toISOString();
		const totalMs = completedAt.getTime() - this.queuedWppStartedAt(item, payload);
		// SEND_FAILED already alerts; a slow failure only gets its single `slow` log line.
		const slow = totalMs > INTERNAL_WPP_SLOW_SEND_MS && !timing.slowAlertedAt;
		if (slow) timing.slowAlertedAt = timing.completedAt;
		payload.timing = timing;
		if (item.internalMessageId) {
			await this.updateMessageStatusAndNotify(
				item.internalMessageId,
				"ERROR",
				whatsappRetryHint({ exists: true, retryGeneration: payload.retryGeneration, outcome })
			);
		}
		Logger.error(`[InternalWhatsappQueue] ${error}`);
		const entry = JSON.stringify(this.queuedWppLogEntry(item, payload, job, "ERROR", totalMs));
		if (slow) Logger.info(`[internal-wpp-send] slow ${entry}`);
		Logger.info(`[internal-wpp-send] ${entry}`);
		this.emitQueuedWppAlert("SEND_FAILED", item, payload, job, OUTCOME_SUMMARIES[kind], totalMs);
		return { status: queueStatus, error: `${outcomeErrorPrefix(kind)} ${error}`, messageData: JSON.stringify(payload) };
	}

	public async processQueuedWppGroupMessage(
		item: InternalWhatsappQueueItem
	): Promise<InternalWhatsappQueueProcessResult> {
		if (!item.internalMessageId) {
			return { status: "FAILED", error: "Queue item has no internal message ID" };
		}

		const payload = JSON.parse(item.messageData) as InternalWhatsappQueuePayload;
		const message = await prismaService.internalMessage.findUnique({ where: { id: item.internalMessageId } });
		if (!message) return { status: "FAILED", error: `Internal message ${item.internalMessageId} not found` };

		const client = whatsappService.getClient(payload.clientId);
		if (!client?.submitMessageJob || !client.getMessageJob) {
			throw new Error(`Remote WhatsApp client ${payload.clientId} is not available`);
		}

		const process = new ProcessingLogger(item.instance, "internal-wpp-async-job", item.id, {
			internalMessageId: item.internalMessageId,
			groupId: item.groupId,
			clientId: payload.clientId
		});
		const data: InternalSendMessageData = {
			chatId: String(item.internalChatId),
			text: message.body,
			...(payload.data.quotedId !== undefined ? { quotedId: payload.data.quotedId } : {}),
			...(payload.data.sendAsAudio !== undefined ? { sendAsAudio: payload.data.sendAsAudio } : {}),
			...(payload.data.sendAsDocument !== undefined ? { sendAsDocument: payload.data.sendAsDocument } : {}),
			...(payload.data.mentions !== undefined ? { mentions: payload.data.mentions as Mention[] | string } : {})
		};
		// Generation 0 keeps the historical key; each manual resend gets a new remote job.
		const idempotencyKey = internalWppIdempotencyKey(
			item.instance,
			item.internalMessageId,
			payload.retryGeneration ?? 0
		);
		const timing = { ...(payload.timing || {}) };
		const firstClaimAt = isoOrNull(item.processingStartedAt);
		if (!timing.firstClaimAt && firstClaimAt) timing.firstClaimAt = firstClaimAt;

		try {
			let job: RemoteMessageJobResponse;
			if (payload.remoteJobId) {
				job = await client.getMessageJob(payload.remoteJobId);
			} else {
				const options = await this.buildQueuedWppGroupMessageOptions(
					payload.session,
					item.groupId,
					data,
					message,
					process
				);
				job = await client.submitMessageJob(options, true, idempotencyKey);
			}
			if (!payload.remoteJobId) {
				payload.remoteJobId = job.jobId;
				timing.submittedAt = new Date().toISOString();
				payload.timing = timing;
				await prismaService.internalMessageProcessingQueue.update({
					where: { id: item.id },
					data: { messageData: JSON.stringify(payload) }
				});
			}

			const verdict = classifyInternalWppJob(job);
			if (verdict.state === "PENDING") {
				return this.pendingQueuedWppMessage(item, payload, timing, job, verdict.reason === "VERIFYING");
			}

			if (verdict.state === "SENT" && job.result) {
				const { isGroup: _isGroup, groupId: _groupId, authorName: _authorName, ...sentMessage } = job.result;
				await this.persistGeneratedWppIds(message.id, sentMessage, process, payload.clientId);
				await this.updateMessageStatusAndNotify(message.id, "RECEIVED");
				process.success({ jobId: job.jobId, wwebjsId: sentMessage.wwebjsId });
				return this.completeQueuedWppMessage(item, payload, timing, job);
			}

			const failure =
				verdict.state === "ERROR"
					? verdict
					: ({ kind: "UNKNOWN", queueStatus: "UNKNOWN", error: `Remote job ${job.jobId} was sent without a result` } as const);
			process.failed(new Error(failure.error));
			return this.finishQueuedWppError(item, payload, timing, job, failure.kind, failure.queueStatus, failure.error);
		} catch (error) {
			if (axios.isAxiosError(error) && error.response?.status === 404 && payload.remoteJobId) {
				const message = `Remote message job ${payload.remoteJobId} disappeared; delivery outcome is unknown`;
				return this.finishQueuedWppError(item, payload, timing, null, "UNKNOWN", "UNKNOWN", message);
			}
			if (
				axios.isAxiosError(error) &&
				error.response &&
				error.response.status >= 400 &&
				error.response.status < 500 &&
				![404, 408, 429].includes(error.response.status)
			) {
				// A rejected request (e.g. idempotency conflict) is not proof the message never left.
				const message = `Remote message job rejected with HTTP ${error.response.status}`;
				return this.finishQueuedWppError(item, payload, timing, null, "FAILED", "FAILED", message);
			}
			throw error;
		}
	}

	/**
	 * Manual "Reenviar" of a failed internal-group message. Only the author or an
	 * ADMIN may resend; an outcome that is not provably unsent needs explicit
	 * confirmation because the group may receive the message twice.
	 */
	public async retryWppGroupMessage(
		session: SessionData,
		id: number,
		options: { confirmUncertain?: boolean } = {}
	): Promise<{ id: number; status: "PENDING" }> {
		const message = await prismaService.internalMessage.findUnique({ where: { id }, include: { chat: true } });
		if (!message || message.instance !== session.instance) {
			throw new InternalWppRetryError(404, "NOT_FOUND", "Mensagem não encontrada.");
		}
		if (message.from !== `user:${session.userId}` && session.role !== "ADMIN") {
			throw new InternalWppRetryError(
				403,
				"FORBIDDEN",
				"Apenas o autor da mensagem ou um administrador pode reenviá-la."
			);
		}
		const notRetryable = (text: string) => new InternalWppRetryError(409, "NOT_RETRYABLE", text);
		if (!message.chat?.wppGroupId) throw notRetryable("Este chat não está vinculado a um grupo do WhatsApp.");
		const syncEnabled = await parametersService.isInternalGroupWhatsappSyncEnabled(
			session.instance,
			LEGACY_INTERNAL_GROUP_WHATSAPP_SYNC_DEFAULT
		);
		if (!syncEnabled) throw notRetryable("A sincronização com grupos do WhatsApp está desativada.");
		if (message.status !== "ERROR" || message.wwebjsId || message.wwebjsIdStanza) {
			throw notRetryable("Somente mensagens com falha de envio podem ser reenviadas.");
		}

		const row = await prismaService.internalMessageProcessingQueue.findFirst({ where: { internalMessageId: id } });
		if (!row || row.instance !== session.instance) {
			throw notRetryable("Não há registro de envio desta mensagem para reaproveitar.");
		}
		if (row.status !== "FAILED" && row.status !== "UNKNOWN") {
			throw notRetryable("O envio desta mensagem ainda está em andamento.");
		}
		// The resend reuses the original row (group and client), so it must still match the chat.
		if (row.groupId !== message.chat.wppGroupId) {
			throw notRetryable("O grupo do WhatsApp vinculado a este chat mudou desde o envio original.");
		}
		const payload = parseQueuePayload<InternalWhatsappQueuePayload>(row.messageData);
		if (!payload || typeof payload.clientId !== "number" || !payload.session) {
			throw notRetryable("O registro de envio desta mensagem é inválido.");
		}
		const client = whatsappService.getClient(payload.clientId);
		if (!client?.submitMessageJob || !client.getMessageJob) {
			throw notRetryable("O cliente do WhatsApp usado no envio original não está disponível.");
		}

		const generation = payload.retryGeneration ?? 0;
		if (generation >= INTERNAL_WPP_MAX_RETRY_GENERATIONS) {
			throw new InternalWppRetryError(409, "RETRY_LIMIT", "Limite de reenvios atingido para esta mensagem.");
		}
		const lastRetryAt = timeMs(payload.lastRetryAt);
		if (lastRetryAt !== null && Date.now() - lastRetryAt < INTERNAL_WPP_RETRY_COOLDOWN_MS) {
			throw new InternalWppRetryError(409, "RETRY_LIMIT", "Aguarde alguns segundos antes de reenviar novamente.");
		}

		const safe = payload.outcome?.safeToResend === true;
		if (!safe && options.confirmUncertain !== true) {
			throw new InternalWppRetryError(
				409,
				"CONFIRMATION_REQUIRED",
				"Não foi possível confirmar se esta mensagem chegou ao grupo. Se ela tiver chegado, o grupo vai recebê-la duas vezes."
			);
		}
		if (!safe) {
			Logger.info(
				`[internal-wpp-retry] uncertain confirmed by user ${session.userId} (message ${id}, queue ${row.id}, outcome ${payload.outcome?.kind ?? "LEGACY"})`
			);
		}

		// Atomic claim: concurrent resends (or a late receipt) cannot both pass.
		const claimed = await prismaService.internalMessage.updateMany({
			where: { id, status: "ERROR", wwebjsId: null, wwebjsIdStanza: null },
			data: { status: "PENDING" }
		});
		if (claimed.count !== 1) throw notRetryable("Esta mensagem já está sendo reenviada.");

		// Reuse the original payload: the WhatsApp text keeps the original author's name.
		const { remoteJobId: _remoteJobId, outcome: _outcome, timing: _timing, ...base } = payload;
		const nextPayload: InternalWhatsappQueuePayload = {
			...base,
			retryGeneration: generation + 1,
			lastRetryAt: new Date().toISOString(),
			lastRetryBy: session.userId,
			timing: {}
		};
		const releaseClaim = () =>
			prismaService.internalMessage.updateMany({ where: { id, status: "PENDING" }, data: { status: "ERROR" } });
		let reopened: boolean;
		try {
			// Conditional on the payload read above: decisions made from a stale snapshot never apply.
			reopened = await internalWhatsappMessageQueueService.reopenForManualRetry(
				row.id,
				row.messageData,
				JSON.stringify(nextPayload)
			);
		} catch (error) {
			await releaseClaim().catch((rollbackError) =>
				Logger.error(
					`[internal-wpp-retry] claim rollback failed for message ${id}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
				)
			);
			throw error;
		}
		if (!reopened) {
			await releaseClaim();
			throw notRetryable("Não foi possível reabrir o envio desta mensagem.");
		}

		Logger.info(
			`[internal-wpp-retry] ${JSON.stringify({
				internalMessageId: id,
				queueId: row.id,
				instance: session.instance,
				userId: session.userId,
				retryGeneration: generation + 1,
				previousOutcome: payload.outcome?.kind ?? null,
				confirmedUncertain: !safe
			})}`
		);
		// The claim already persisted PENDING; the worker may have finished since, so publish
		// whatever is stored now instead of writing the status again.
		try {
			const current = await prismaService.internalMessage.findUnique({ where: { id } });
			if (current) await this.emitMessageStatus(current);
		} catch (error) {
			Logger.error(
				`[internal-wpp-retry] status notify failed for message ${id}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		return { id, status: "PENDING" };
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
				await this.persistGeneratedWppIds(message.id, result, process, sector.defaultClientId);
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
				await this.persistGeneratedWppIds(message.id, result, process, sector.defaultClientId);
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
