import "dotenv/config";
import { FileDirType, SessionData } from "@in.pulse-crm/sdk";
import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { InternalMessage, WppChat, WppClientType, WppMessage, WppSector } from "@prisma/client";
import { BadRequestError, InternalServerError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";
import {
	EditMessageOptions,
	SendFileOptions,
	SendFileType,
	SendMessageOptions
} from "../types/whatsapp-instance.types";
import WhatsappAudioConverter from "../utils/whatsapp-audio-converter";
import ProcessingLogger from "../utils/processing-logger";
import GupshupWhatsappClient from "../whatsapp-client/gupshup-whatsapp-client";
import WABAWhatsappClient from "../whatsapp-client/waba-whatsapp-client";
import WhatsappClient from "../whatsapp-client/whatsapp-client";
import WWEBJSWhatsappClient from "../whatsapp-client/wwebjs-whatsapp-client";
import filesService from "./files.service";
import instancesService from "./instances.service";
import internalChatsService from "./internal-chats.service";
import messagesDistributionService from "./messages-distribution.service";
import messagesService from "./messages.service";
import prismaService from "./prisma.service";
import { TemplateMessage } from "../adapters/template.adapter";
import { TemplateVariables } from "../types/whatsapp-api.types";
import RemoteWhatsappClient from "../whatsapp-client/remote-whatsapp-client";

export interface SendTemplateData {
	template: TemplateMessage;
	templateVariables: TemplateVariables;
	components: string[];
}

interface SendBotMessageData {
	chat: WppChat;
	text: string;
	quotedId?: number | null;
}
interface WhatsappForwardTarget {
	id: string;
	isGroup: boolean;
}

interface InternalForwardTarget {
	id: number;
}
interface SendMessageData {
	sendAsChatOwner?: boolean;
	sendAsAudio?: boolean;
	sendAsDocument?: boolean;
	contactId: number;
	quotedId?: number | null;
	chatId?: number | null;
	text?: string | null;
	file?: Express.Multer.File;
	fileId?: number;
	isForwarded?: boolean;
}

interface EditMessageData {
	options: EditMessageOptions;
	session: SessionData;
	logger: ProcessingLogger;
}

export function getMessageType(fileType: string, isAudio: boolean, isDocument: boolean) {
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

class WhatsappService {
	private readonly clients = new Map<number, WhatsappClient>();

	public async buildClients() {
		const clients = await prismaService.wppClient.findMany({
			where: {
				isActive: true
			}
		});

		for (const client of clients) {
			switch (client.type) {
				case WppClientType.WWEBJS:
					const WWEBJSClient = new WWEBJSWhatsappClient(client.id, client.instance, client.name);
					this.clients.set(client.id, WWEBJSClient);
					break;
				case WppClientType.WABA:
					const WABAClient = new WABAWhatsappClient(
						client.id,
						client.instance,
						client.name,
						client.phone || "",
						client.WABAPhoneId || "",
						client.WABAAccountId || "",
						client.WABAToken || ""
					);
					this.clients.set(client.id, WABAClient);
					break;
				case WppClientType.GUPSHUP:
					const GUPSHUPClient = new GupshupWhatsappClient(
						client.id,
						client.instance,
						client.name,
						client.phone || "",
						client.gupshupToken || "",
						client.gupshupAppName || "",
						client.gupshupAppId || ""
					);
					this.clients.set(client.id, GUPSHUPClient);
					break;
				case WppClientType.REMOTE:
					const RemoteClient = new RemoteWhatsappClient(
						client.id,
						client.instance,
						client.name,
						client.phone || "",
						client.remoteClientUrl || ""
					);
					this.clients.set(client.id, RemoteClient);
					break;
				default:
					break;
			}
		}
	}

	public getClient(id: number) {
		return this.clients.get(id);
	}

	public async getClientsBySector(sectorId: number) {
		const sector = await prismaService.wppSector.findUniqueOrThrow({
			where: { id: sectorId },
			include: { clients: true }
		});

		return sector.clients.map((c) => ({
			id: c.id,
			name: c.name,
			type: c.type
		}));
	}

	public async editMessage({ session, options }: EditMessageData) {
		const process = new ProcessingLogger(
			session.instance,
			"edit-message",
			`${session.userId}-${Date.now()}`,
			options
		);
		process.log("Iniciando o processo de edição de mensagem.");
		try {
			const message = await prismaService.wppMessage.findUniqueOrThrow({
				where: { wwebjsId: options.messageId }
			});

			if (!message.clientId) {
				throw new BadRequestError("Mensagem não possui client associado.");
			}

			process.log("Obtendo client do whatsapp...");
			const client = this.getClient(message.clientId);

			if (!client) {
				throw new BadRequestError("Client do WhatsApp não encontrado.");
			}

			process.log(`Client obtido para o setor: ${session.sectorId}`);
			const editedMsg = await client.editMessage(options);

			return editedMsg;
		} catch (err) {
			process.log("Erro ao editar mensagem no WhatsApp.", err);
			process.failed("Erro ao editar mensagem: " + sanitizeErrorMessage(err));
			throw new BadRequestError("Erro ao editar mensagem.", err);
		}
	}

	public async sendMessage(session: SessionData, clientId: number, to: string, data: SendMessageData) {
		const { file, ...logData } = data;
		const process = new ProcessingLogger(session.instance, "send-message", `${to}-${Date.now()}`, logData);

		Logger.debug(`Enviando mensagem para ${to} via WhatsApp (Client ID: ${clientId})`);

		process.log("Iniciando o envio da mensagem.");
		try {
			process.log("Obtendo client do whatsapp...");
			const client = this.getClient(clientId);

			if (!client) {
				throw new BadRequestError("Client do WhatsApp não encontrado.");
			}

			process.log(`Client obtido | clientId: ${clientId} | instance: ${session.instance}`);
			const text = `*${session.name}*: ${data.text || ""}`;
			const now = new Date();

			let message = {
				instance: session.instance,
				status: "PENDING",
				timestamp: now.getTime().toString(),
				sentAt: now,
				from: `me:${client._phone}`,
				to: `${to}`,
				type: "chat",
				body: data.text || "",
				userId: session.userId
			} as CreateMessageDto;

			let options = { to, text: text } as SendMessageOptions;

			data.contactId && (message.contactId = +data.contactId);
			data.chatId && (message.chatId = +data.chatId);

			if (data.quotedId) {
				process.log(`Mensagem citada encontrada: ${data.quotedId}`);
				const quotedMsg = await prismaService.wppMessage.findUniqueOrThrow({
					where: {
						id: +data.quotedId
					}
				});

				options.quotedId = (quotedMsg.wwebjsId || quotedMsg.wabaId)!;
				message.quotedId = quotedMsg.id;
				process.log(`ID enviado: ${options.quotedId}`);
			}

			if ("fileId" in data && !!data.fileId) {
				process.log(`Processando arquivo com ID: ${data.fileId}`);

				const fileData = await filesService.fetchFileMetadata(data.fileId);

				process.log(`Arquivo encontrado: ${fileData.name}`);
				let fileType = "document";

				if (fileData.mime_type.startsWith("image/")) {
					fileType = "image";
				}
				if (fileData.mime_type.startsWith("video/")) {
					fileType = "video";
				}
				if (data.sendAsAudio) {
					fileType = "audio";
				}

				options = {
					...options,
					fileUrl: filesService.getFileDownloadUrl(data.fileId),
					sendAsAudio: !!data.sendAsAudio,
					sendAsDocument: !!data.sendAsDocument,
					fileName: fileData.name,
					fileType,
					file: fileData
				} as SendFileOptions;

				message.fileId = +data.fileId;
				message.fileName = fileData.name;
				message.fileType = fileData.mime_type;
				message.fileSize = String(fileData.size);
				message.type = getMessageType(fileData.mime_type, !!data.sendAsAudio, !!data.sendAsDocument);
				process.log("Arquivo processado com sucesso.", message);
			}

			if ("file" in data && !!data.file) {
				process.log(`Processando arquivo enviado diretamente: ${data.file.originalname}`);

				if (data.sendAsAudio) {
					const convertedAudio = await WhatsappAudioConverter.convertToCompatible(
						data.file.buffer,
						data.file.mimetype
					);

					process.log("Mensagem de audio, convertendo arquivo para " + convertedAudio.extension);

					data.file.buffer = convertedAudio.buffer;
					data.file.mimetype = convertedAudio.mimeType;
					data.file.originalname = data.file.originalname.replace(
						/\.[^/.]+$/,
						"." + convertedAudio.extension
					);
					data.file.size = convertedAudio.size;
					
					process.log("Mensagem convertida com sucesso.");
				}

				const savedFile = await filesService.uploadFile({
					instance: session.instance,
					fileName: data.file.originalname,
					mimeType: data.file.mimetype,
					buffer: data.file.buffer,
					dirType: FileDirType.PUBLIC
				});

				process.log(`Arquivo salvo com sucesso!`, savedFile);

				const fileUrl = filesService.getFileDownloadUrl(savedFile.id);
				let fileType = "document";

				if (data.file.mimetype.startsWith("image/")) {
					fileType = "image";
				}
				if (data.file.mimetype.startsWith("video/")) {
					fileType = "video";
				}
				if (data.sendAsAudio) {
					fileType = "audio";

					(options as SendFileOptions).sendAsAudio = false;
					(options as SendFileOptions).sendAsDocument = true;
				}

				options = {
					...options,
					fileUrl,
					fileType,
					sendAsAudio: false,
					sendAsDocument: data.sendAsDocument,
					file: savedFile
				} as SendFileOptions;

				message.fileId = savedFile.id;
				message.fileName = savedFile.name;
				message.fileType = savedFile.mime_type;
				message.fileSize = String(savedFile.size);

				message.type = getMessageType(data.file.mimetype, !!data.sendAsAudio, !!data.sendAsDocument);
				process.log("Arquivo processado com sucesso.", message);
			}

			process.log("Salvando mensagem no banco de dados.", message);
			const pendingMsg = await messagesService.insertMessage(message);
			process.log("Enviando mensagem para o cliente.");

			messagesDistributionService.notifyMessage(process, pendingMsg);
			process.log("Mensagem pendente notificada via socket.", pendingMsg);

			process.log("Enviando mensagem para o WhatsApp.", options);
			const sentMsg = await client.sendMessage(options);
			process.log("Atualizando mensagem no banco de dados.", sentMsg);

			message = {
				...pendingMsg,
				...sentMsg,
				status: "SENT",
				isForwarded:
					typeof sentMsg.isForwarded === "boolean"
						? sentMsg.isForwarded
						: typeof pendingMsg.isForwarded === "boolean"
							? pendingMsg.isForwarded
							: false
			} as CreateMessageDto;

			const savedMsg = await messagesService.updateMessage(pendingMsg.id, message);

			messagesDistributionService.notifyMessage(process, savedMsg);
			process.log("Mensagem salva no banco de dados.", savedMsg);
			process.success(savedMsg);

			return savedMsg;
		} catch (err) {
			process.failed("Erro ao enviar mensagem: " + sanitizeErrorMessage(err));
			throw new BadRequestError("Erro ao enviar mensagem: " + sanitizeErrorMessage(err), err);
		}
	}

	public async sendBotMessage(to: string, clientId: number, data: SendBotMessageData) {
		const process = new ProcessingLogger(data.chat.instance, "send-bot-message", `${to}-${Date.now()}`, data);

		process.log("Iniciando o envio da mensagem.");
		try {
			process.log("Obtendo client do whatsapp...");
			const client = this.getClient(clientId);
			if (!client) {
				throw new BadRequestError("Client do WhatsApp não encontrado.");
			}

			process.log(`Client obtido para o setor: ${data.chat.sectorId || 1}`);
			const now = new Date();

			let message = {
				instance: data.chat.instance,
				status: "PENDING",
				timestamp: now.getTime().toString(),
				sentAt: now,
				from: `bot:${client._phone}`,
				to: `${to}`,
				type: "chat",
				body: data.text || ""
			} as CreateMessageDto;

			let options = { to, text: data.text } as SendMessageOptions;
			message.chatId = data.chat.id;
			data.chat.contactId && (message.contactId = data.chat.contactId);

			if (data.quotedId) {
				process.log(`Mensagem citada encontrada: ${data.quotedId}`);
				const quotedMsg = await prismaService.wppMessage.findUniqueOrThrow({
					where: {
						id: +data.quotedId
					}
				});

				options.quotedId = (quotedMsg.wwebjsId || quotedMsg.wabaId)!;
				message.quotedId = quotedMsg.id;
			}
			process.log("Salvando mensagem no banco de dados.", message);
			const pendingMsg = await messagesService.insertMessage(message);
			process.log("Enviando mensagem para o cliente.", options);

			const delay = Math.floor(Math.random() * (5000 - 500 + 1)) + 500;
			process.log(`Aguardando ${delay}ms antes de enviar a mensagem...`);
			await new Promise((resolve) => setTimeout(resolve, delay));
			const sentMsg = await client.sendMessage(options);
			process.log("Atualizando mensagem no banco de dados.", sentMsg);

			message = {
				...pendingMsg,
				...sentMsg,
				status: "SENT",
				isForwarded:
					typeof sentMsg.isForwarded === "boolean"
						? sentMsg.isForwarded
						: typeof pendingMsg.isForwarded === "boolean"
							? pendingMsg.isForwarded
							: false // <- garante que nunca será null
			} as CreateMessageDto;

			const savedMsg = await messagesService.updateMessage(pendingMsg.id, message);
			process.log("Mensagem salva no banco de dados.", savedMsg);

			messagesDistributionService.notifyMessage(process, savedMsg);
			process.success(savedMsg);

			return savedMsg;
		} catch (err) {
			process.failed("Erro ao enviar mensagem: " + sanitizeErrorMessage(err));
			throw new BadRequestError("Erro ao enviar mensagem.", err);
		}
	}

	public async getResults(instance: string) {
		const query = "SELECT CODIGO AS id, NOME AS name, COD_ACAO FROM resultados";
		const result = await instancesService.executeQuery<{ id: number; name: string }[]>(instance, query, []);

		return result;
	}

	private unsafeGetWwebjsClient(instance: string): WWEBJSWhatsappClient | null {
		const correctClient = this.getWwebjsClient(instance);

		if (correctClient) {
			return correctClient;
		}

		const clients = this.clients.values();
		const wwebjsClient: WWEBJSWhatsappClient =
			(Array.from(clients).find(
				(client) => client instanceof WWEBJSWhatsappClient && client.isReady
			) as WWEBJSWhatsappClient) || null;

		return wwebjsClient;
	}

	private getWwebjsClient(instance: string): WWEBJSWhatsappClient | null {
		const clients = this.clients.values();
		const wwebjsClient: WWEBJSWhatsappClient =
			(Array.from(clients).find(
				(client) => client instanceof WWEBJSWhatsappClient && client.instance === instance && client.isReady
			) as WWEBJSWhatsappClient) || null;

		return wwebjsClient;
	}

	public async getWabaClientByRecipient(recipient: string): Promise<WABAWhatsappClient | null> {
		const findClient = await prismaService.wppClient.findFirst({
			where: {
				type: "WABA",
				phone: recipient
			}
		});

		if (!findClient) {
			return null;
		}

		const instancedClient = this.getClient(findClient.id);

		if (instancedClient instanceof WABAWhatsappClient) {
			return instancedClient;
		}

		return null;
	}

	public async getValidWhatsappPhone(instance: string, phone: string) {
		const wwebjs = this.unsafeGetWwebjsClient(instance);
		const validPhone = wwebjs ? await wwebjs?.getValidWhatsapp(phone) : phone;

		return validPhone;
	}

	public async getProfilePictureUrl(instance: string, phone: string) {
		try {
			const wwebjs = this.unsafeGetWwebjsClient(instance);
			const url = wwebjs ? await wwebjs?.getProfilePictureUrl(phone) : null;

			return url;
		} catch {
			return null;
		}
	}

	public async getGroups(clientId: number) {
		const client = this.getClient(clientId);
		if (!(client instanceof WWEBJSWhatsappClient)) {
			throw new BadRequestError("Client is not WWEBJS client");
		}

		const groups = await client.getGroups();

		return groups;
	}

	public async sendTemplate(
		session: SessionData,
		clientId: number,
		to: string,
		data: SendTemplateData,
		chatId: number,
		contactId: number
	) {
		const process = new ProcessingLogger(session.instance, "send-template", `${to}-${Date.now()}`, data);

		try {
			const client = this.getClient(clientId);

			if (!client) {
				throw new BadRequestError("Client do WhatsApp não encontrado.");
			}

			const message = await client.sendTemplate(
				{
					to,
					template: data.template,
					templateVariables: data.templateVariables,
					components: data.components
				},
				chatId,
				contactId
			);

			const savedMsg = await messagesService.insertMessage(message);
			process.log("Mensagem salva no banco de dados.", savedMsg);

			messagesDistributionService.notifyMessage(process, savedMsg);
			process.success("Mensagem de template enviada com sucesso.");
		} catch (error) {
			process.failed("Erro ao enviar mensagem de template.\n" + sanitizeErrorMessage(error));
		}
	}

	public async getTemplates(clientId: number) {
		const client = this.getClient(clientId);
		console.log("Fetching templates for clientId:", clientId, "Client found:", !!client);
		if (!client) {
			throw new BadRequestError("Client do WhatsApp não encontrado.");
		}
		const templates = await client.getTemplates();

		return templates;
	}

	public async forwardMessages(
		session: SessionData,
		clientId: number,
		messageIds: number[],
		sourceType: "whatsapp" | "internal",
		whatsappTargets?: WhatsappForwardTarget[],
		internalTargets?: InternalForwardTarget[]
	): Promise<void> {
		const process = new ProcessingLogger(
			session.instance,
			"forward-messages-service",
			`user:${session.userId}-${Date.now()}`,
			{
				messageCount: messageIds.length,
				whatsappTargetCount: whatsappTargets?.length || 0,
				internalTargetCount: internalTargets?.length || 0
			}
		);

		process.log("Iniciando processo de encaminhamento nativo com salvamento no banco.");

		const originalMessages: Array<WppMessage> | Array<InternalMessage> = [];

		if (sourceType === "whatsapp") {
			const whatsappMessages = await prismaService.wppMessage.findMany({
				where: { id: { in: messageIds } }
			});
			(originalMessages as Array<WppMessage>).push(...whatsappMessages);
		} else if (sourceType === "internal") {
			const internalMessages = await prismaService.internalMessage.findMany({
				where: { id: { in: messageIds } }
			});
			(originalMessages as Array<InternalMessage>).push(...internalMessages);
		}
		if (originalMessages.length === 0) {
			process.log("Nenhuma mensagem original foi encontrada para encaminhar.");
			return;
		}

		if (whatsappTargets && whatsappTargets.length > 0) {
			try {
				const client = await this.getClient(clientId);

				if (!(client instanceof WWEBJSWhatsappClient)) {
					throw new BadRequestError(
						"O encaminhamento nativo só é suportado por conexões do tipo QR Code (WWEBJS)."
					);
				}

				for (const target of whatsappTargets) {
					try {
						const contact = await prismaService.wppContact.findUnique({
							where: {
								instance_phone: {
									instance: session.instance,
									phone: target.id
								}
							}
						});
						const chat = contact
							? await prismaService.wppChat.findFirst({
									where: {
										instance: session.instance,
										contactId: contact.id
									}
								})
							: null;

						for (const originalMsg of originalMessages) {
							const now = new Date();
							const messageToSave: CreateMessageDto = {
								clientId: clientId,
								instance: session.instance,
								status: "SENT",
								timestamp: now.getTime().toString(),
								sentAt: now,
								from: `me:${client._phone}`,
								to: target.id,
								type: originalMsg.type,
								body: originalMsg.body,
								isForwarded: true,
								contactId: contact?.id ?? null,
								chatId: chat?.id ?? null,
								fileId: originalMsg.fileId,
								fileName: originalMsg.fileName,
								fileType: originalMsg.fileType,
								fileSize: originalMsg.fileSize
							};

							const savedMsg = await messagesService.insertMessage(messageToSave);
							messagesDistributionService.notifyMessage(process, savedMsg);
							process.log(
								`Registro da mensagem ID:${originalMsg.id} salvo no banco para o alvo: ${target.id}. Novo ID: ${savedMsg.id}`
							);
							if (sourceType === "internal") {
								const options = {
									to: target.id,
									text: originalMsg.body || undefined
								} as SendMessageOptions | SendFileOptions;

								if (originalMsg.fileId) {
									(options as SendFileOptions).fileUrl = filesService.getFileDownloadUrl(
										originalMsg.fileId
									);
									(options as SendFileOptions).fileName = originalMsg.fileName!;
									(options as SendFileOptions).fileType = originalMsg.fileType! as SendFileType;
									(options as SendFileOptions).sendAsAudio = originalMsg.type === "ptt";
									(options as SendFileOptions).sendAsDocument = originalMsg.type === "document";
								}

								await client.sendMessage(options);
							} else {
								await client.forwardMessage(target.id, originalMsg.wwebjsId!, target.isGroup);
							}

							process.log(
								`Mensagem ID:${originalMsg.id} encaminhada com sucesso via WhatsApp para: ${target.id}`
							);
						}
					} catch (err) {
						process.failed(
							`Falha ao processar encaminhamento para o alvo ${target.id}: ${sanitizeErrorMessage(err)}`
						);
					}
				}
			} catch (error) {
				process.failed(`Erro no bloco de encaminhamento para o WhatsApp: ${sanitizeErrorMessage(error)}`);
			}
		}

		if (internalTargets && internalTargets.length > 0) {
			try {
				process.log(`Iniciando encaminhamento para ${internalTargets.length} alvo(s) internos.`);
				await internalChatsService.forwardWppMessagesToInternal(
					session,
					originalMessages,
					sourceType,
					internalTargets.map((t) => t.id)
				);
				process.log("Encaminhamento para alvos internos delegado com sucesso.");
			} catch (error) {
				process.failed(`Erro no bloco de encaminhamento para chats internos: ${sanitizeErrorMessage(error)}`);
			}
		}

		process.success("Processo de encaminhamento concluído.");
	}

	public async sendAutoReplyMessage(
		instance: string,
		sector: WppSector,
		to: string,
		text: string,
		fileId?: number | null
	) {
		const process = new ProcessingLogger(instance, "send-auto-reply", `${to}-${Date.now()}`, { to, text, fileId });

		try {
			process.log(`Iniciando envio de resposta automática para ${to}`);
			const client = this.getClient(sector.defaultClientId!);

			if (!client) {
				throw new InternalServerError("Client do WhatsApp não encontrado.");
			}
			const contact = await prismaService.wppContact.findUnique({
				where: { instance_phone: { instance, phone: to } }
			});
			const chat = contact
				? await prismaService.wppChat.findFirst({
						where: { contactId: contact.id, isFinished: false }
					})
				: null;

			// Prepara as opções de envio (texto ou arquivo)
			let options: SendMessageOptions | SendFileOptions = { to, text };
			let messageType = "chat";
			let fileData;

			if (fileId) {
				fileData = await filesService.fetchFileMetadata(fileId);
				const fileUrl = filesService.getFileDownloadUrl(fileId);

				messageType = getMessageType(fileData.mime_type, false, false);

				(options as SendFileOptions).fileUrl = fileUrl;
				(options as SendFileOptions).fileName = fileData.name;
				(options as SendFileOptions).fileType = messageType as "image" | "video" | "audio" | "document";
			}

			// Envia a mensagem (texto ou mídia) pelo client
			const sentMsgInfo = await client.sendMessage(options);

			// Cria o objeto para salvar no histórico do banco de dados
			const now = new Date();
			const messageToSave: CreateMessageDto = {
				clientId: client.id,
				instance,
				from: "system:auto-reply",
				to: to,
				body: text,
				status: "SENT",
				type: messageType,
				timestamp: now.getTime().toString(),
				sentAt: now,
				contactId: contact?.id ?? null,
				chatId: chat?.id ?? null,
				fileId: fileId || null,
				fileName: fileId ? (options as SendFileOptions).fileName : null,
				fileType: fileId && fileData ? fileData.mime_type : null,
				wwebjsId: sentMsgInfo.wwebjsId || null,
				wabaId: sentMsgInfo.wabaId || null
			};

			const savedMsg = await messagesService.insertMessage(messageToSave);
			process.log("Resposta automática salva no histórico.", savedMsg);

			if (savedMsg.chatId) {
				messagesDistributionService.notifyMessage(process, savedMsg);
			}
			process.success("Resposta automática enviada com sucesso.");

			return savedMsg;
		} catch (err) {
			process.failed(`Erro ao enviar resposta automática: ${sanitizeErrorMessage(err)}`);

			return undefined;
		}
	}

	/**
	 * Verifica se a janela de conversa ainda está aberta para um contato
	 * @param instance - Instância do WhatsApp
	 * @param phone - Telefone do contato
	 * @returns true se a janela estiver aberta, false caso contrário
	 */
	public async isConversationWindowOpen(instance: string, phone: string): Promise<boolean> {
		const process = new ProcessingLogger(instance, "check-conversation-window", phone, { phone });

		try {
			process.log("Verificando janela de conversa...");

			const contact = await prismaService.wppContact.findUnique({
				where: {
					instance_phone: {
						instance,
						phone
					}
				}
			});

			if (!contact) {
				process.log("Contato não encontrado - janela considerada fechada");
				process.success("Verificação concluída com sucesso.");
				return false;
			}

			if (!contact.conversationExpiration) {
				process.log("Contato sem data de expiração - janela considerada fechada");
				process.success("Verificação concluída com sucesso.");
				return false;
			}

			process.log("Contato encontrado, verificando data de expiração da conversa...", {
				conversationExpiration: contact.conversationExpiration
			});
			const expirationDate = new Date(+contact.conversationExpiration);
			const now = new Date();

			const isOpen = now < expirationDate;

			process.log(`Janela de conversa ${isOpen ? "ABERTA" : "FECHADA"}`, {
				expirationDate: expirationDate.toISOString(),
				currentDate: now.toISOString(),
				timeUntilExpiration: isOpen ? expirationDate.getTime() - now.getTime() : 0
			});
			process.success("Verificação concluída com sucesso.");

			return isOpen;
		} catch (err: any) {
			Logger.error("Erro ao verificar janela de conversa", err);
			process.failed(`Erro ao verificar janela de conversa: ${sanitizeErrorMessage(err)}`);
			return false; // Em caso de erro, considera a janela fechada por segurança
		}
	}
}

export default new WhatsappService();
