import { FileDirType, SessionData } from "@in.pulse-crm/sdk";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { WppChat, WppClientType } from "@prisma/client";
import { BadRequestError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";
import { EditMessageOptions, SendFileOptions, SendMessageOptions } from "../types/whatsapp-instance.types";
import OpusAudioConverter from "../utils/opus-audio-converter";
import ProcessingLogger from "../utils/processing-logger";
import GupshupWhatsappClient from "../whatsapp-client/gupshup-whatsapp-client";
import WhatsappClient from "../whatsapp-client/whatsapp-client";
import WWEBJSWhatsappClient from "../whatsapp-client/wwebjs-whatsapp-client";
import filesService from "./files.service";
import instancesService from "./instances.service";
import internalChatsService from "./internal-chats.service";
import messagesDistributionService from "./messages-distribution.service";
import messagesService from "./messages.service";
import prismaService from "./prisma.service";
import WABAWhatsappClient from "../whatsapp-client/waba-whatsapp-client";

export interface SendTemplateData {
	templateId: string;
	templateText: string;
	templateParams: string[];
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
		const clients = await prismaService.wppClient.findMany();

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
				default:
					break;
			}
		}
	}

	public getClient(id: number) {
		return this.clients.get(id);
	}

	public async getClientBySector(instance: string, sectorId: number) {
		const dbClient = await prismaService.wppClient.findFirstOrThrow({
			where: {
				instance,
				isActive: true,
				WppSector: {
					some: {
						id: sectorId
					}
				}
			}
		});

		const client = this.getClient(dbClient.id);

		if (!client) {
			throw new BadRequestError("Sector has no active whatsapp client!");
		}

		return client;
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
			process.log("Obtendo client do whatsapp...");
			const client = await this.getClientBySector(session.instance, session.sectorId);

			process.log(`Client obtido para o setor: ${session.sectorId}`);
			const editedMsg = await client.editMessage(options);

			return editedMsg;
		} catch (err) {
			process.log("Erro ao editar mensagem no WhatsApp.", err);
			process.failed("Erro ao editar mensagem: " + sanitizeErrorMessage(err));
			throw new BadRequestError("Erro ao editar mensagem.", err);
		}
	}

	public async sendMessage(session: SessionData, to: string, data: SendMessageData) {
		const { file, ...logData } = data;
		const process = new ProcessingLogger(session.instance, "send-message", `${to}-${Date.now()}`, logData);

		process.log("Iniciando o envio da mensagem.");
		try {
			process.log("Obtendo client do whatsapp...");
			const client = await this.getClientBySector(session.instance, session.sectorId);
			process.log(`Client obtido para o setor: ${session.sectorId}`);
			const text = `*${session.name}*: ${data.text || ""}`;
			const now = new Date();

			let message = {
				instance: session.instance,
				status: "PENDING",
				timestamp: now.getTime().toString(),
				sentAt: now,
				from: `me:${client.phone}`,
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

				message.fileId = data.fileId;
				message.fileName = fileData.name;
				message.fileType = fileData.mime_type;
				message.fileSize = String(fileData.size);
				message.type = getMessageType(fileData.mime_type, !!data.sendAsAudio, !!data.sendAsDocument);
				process.log("Arquivo processado com sucesso.", message);
			}
			if ("file" in data && !!data.file) {
				process.log(`Processando arquivo enviado diretamente: ${data.file.originalname}`);

				if (data.sendAsAudio) {
					process.log("Mensagem de audio, convertendo arquivo para mp3.");
				}

				const buffer = data.sendAsAudio ? await OpusAudioConverter.convert(data.file.buffer) : data.file.buffer;

				if (data.sendAsAudio) {
					process.log("Mensagem convertida com sucesso.");
				}
				const savedFile = await filesService.uploadFile({
					instance: session.instance,
					fileName: data.file.originalname,
					mimeType: data.file.mimetype,
					buffer,
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
				}

				options = {
					...options,
					fileUrl,
					fileType,
					sendAsAudio: data.sendAsAudio,
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
			console.error(err);
			process.failed("Erro ao enviar mensagem: " + sanitizeErrorMessage(err));
			throw new BadRequestError("Erro ao enviar mensagem.", err);
		}
	}

	public async sendBotMessage(to: string, data: SendBotMessageData) {
		const process = new ProcessingLogger(data.chat.instance, "send-bot-message", `${to}-${Date.now()}`, data);

		process.log("Iniciando o envio da mensagem.");
		try {
			process.log("Obtendo client do whatsapp...");
			const client = await this.getClientBySector(data.chat.instance, data.chat.sectorId || 1);
			process.log(`Client obtido para o setor: ${data.chat.sectorId || 1}`);
			const now = new Date();


			let message = {
				instance: data.chat.instance,
				status: "PENDING",
				timestamp: now.getTime().toString(),
				sentAt: now,
				from: `bot:${client.phone}`,
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
			console.error(err);
			process.failed("Erro ao enviar mensagem: " + sanitizeErrorMessage(err));
			throw new BadRequestError("Erro ao enviar mensagem.", err);
		}
	}

	public async getResults(instance: string) {
		const query = "SELECT CODIGO AS id, NOME AS name FROM resultados";
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

	public async getWabaClientByRecipient(phoneId: string): Promise<WABAWhatsappClient | null> {
		const findClient = await prismaService.wppClient.findFirst({
			where: {
				type: "WABA",
				WABAPhoneId: phoneId,
			}
		})

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
		const validPhone = wwebjs ? await wwebjs?.getValidWhatsapp(phone) : null;

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

	public async getGroups(instance: string, sectorId: number) {
		const client = await this.getClientBySector(instance, sectorId);
		if (!(client instanceof WWEBJSWhatsappClient)) {
			throw new BadRequestError("Client is not WWEBJS client");
		}

		const groups = await client.getGroups();

		return groups;
	}

	private async getGupshupClient(session: SessionData) {
		const client = await this.getClientBySector(session.instance, session.sectorId);

		if (!(client instanceof GupshupWhatsappClient)) {
			throw new Error("Invalid WhatsApp client type for Gupshup service.");
		}

		return client;
	}

	public async sendTemplate(
		session: SessionData,
		to: string,
		data: SendTemplateData,
		chatId: number,
		contactId: number
	) {
		const process = new ProcessingLogger(session.instance, "send-template", `${to}-${Date.now()}`, data);

		try {
			const client = await this.getGupshupClient(session);

			const message = await client.sendTemplate(
				{
					to,
					templateId: data.templateId,
					templateText: data.templateText,
					parameters: data.templateParams
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

	public async getTemplates(session: SessionData) {
		const client = await this.getGupshupClient(session);
		const templates = await client.getTemplates();

		return templates.map((t) => ({
			id: t.id,
			name: t.elementName,
			category: t.category,
			text: t.data
		}));
	}

	public async forwardMessages(
		session: SessionData,
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

		let originalMessages: any[] = [];
		if (sourceType === "whatsapp") {
			originalMessages = await prismaService.wppMessage.findMany({
				where: { id: { in: messageIds } }
			});
		} else if (sourceType === "internal") {
			originalMessages = await prismaService.internalMessage.findMany({
				where: { id: { in: messageIds } }
			});
		}
		if (originalMessages.length === 0) {
			process.log("Nenhuma mensagem original foi encontrada para encaminhar.");
			return;
		}

		if (whatsappTargets && whatsappTargets.length > 0) {
			try {
				const client = await this.getClientBySector(session.instance, session.sectorId);

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
								instance: session.instance,
								status: "SENT",
								timestamp: now.getTime().toString(),
								sentAt: now,
								from: `me:${client.phone}`,
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
								const options: SendMessageOptions | SendFileOptions = {
									to: target.id,
									text: originalMsg.body || undefined
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

	private async _getPrimaryClientForInstance(instance: string): Promise<WhatsappClient> {
		const dbClient = await prismaService.wppClient.findFirstOrThrow({
			where: {
				instance,
				isActive: true
			}
		});

		const client = this.getClient(dbClient.id);
		if (!client) {
			throw new BadRequestError(`Nenhum cliente de WhatsApp ativo encontrado para a instância: ${instance}`);
		}
		return client;
	}

	public async sendAutoReplyMessage(instance: string, to: string, text: string, fileId?: number | null, ) {
		const process = new ProcessingLogger(instance, "send-auto-reply", `${to}-${Date.now()}`, { to, text, fileId });

		try {
			process.log(`Iniciando envio de resposta automática para ${to}`);
			const client = await this._getPrimaryClientForInstance(instance);
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
				wabaId: sentMsgInfo.wabaId || null,

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
			console.error("Falha ao enviar resposta automática:", err);
			return undefined;
		}
	}
}

export default new WhatsappService();
