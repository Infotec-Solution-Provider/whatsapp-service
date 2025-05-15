import { WppChat, WppClientType } from "@prisma/client";
import prismaService from "./prisma.service";
import { FileDirType, SessionData } from "@in.pulse-crm/sdk";
import { BadRequestError } from "@rgranatodutra/http-errors";
import OpusAudioConverter from "../utils/opus-audio-converter";
import {
	SendFileOptions,
	SendMessageOptions
} from "../types/whatsapp-instance.types";
import filesService from "./files.service";
import CreateMessageDto from "../dtos/create-message.dto";
import messagesService from "./messages.service";
import messagesDistributionService from "./messages-distribution.service";
import ProcessingLogger from "../utils/processing-logger";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import instancesService from "./instances.service";
import WhatsappClient from "../whatsapp-client/whatsapp-client";
import WWEBJSWhatsappClient from "../whatsapp-client/wwebjs-whatsapp-client";

interface SendBotMessageData {
	chat: WppChat;
	text: string;
	quotedId?: number | null;
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
}

export function getMessageType(
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

class WhatsappService {
	private readonly clients = new Map<number, WhatsappClient>();

	public async buildClients() {
		const clients = await prismaService.wppClient.findMany();

		for (const client of clients) {
			switch (client.type) {
				case WppClientType.WWEBJS:
					const WWEBJSClient = new WWEBJSWhatsappClient(
						client.id,
						client.instance,
						client.name
					);
					this.clients.set(client.id, WWEBJSClient);
					break;
				case WppClientType.WABA:
					throw new Error("WABA client not supported yet!");
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

	public async sendMessage(
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
			process.log("Obtendo client do whatsapp...");
			const client = await this.getClientBySector(
				session.instance,
				session.sectorId
			);
			process.log(`Client obtido para o setor: ${session.sectorId}`);
			let message = {
				instance: session.instance,
				status: "PENDING",
				timestamp: Date.now().toString(),
				from: `me:${client.phone}`,
				to: `${to}`,
				type: "chat",
				body: data.text || ""
			} as CreateMessageDto;

			let options = { to, text: data.text } as SendMessageOptions;

			data.contactId && (message.contactId = +data.contactId);
			data.chatId && (message.chatId = +data.chatId);

			if (data.quotedId) {
				process.log(`Mensagem citada encontrada: ${data.quotedId}`);
				const quotedMsg =
					await prismaService.wppMessage.findUniqueOrThrow({
						where: {
							id: data.quotedId
						}
					});

				options.quotedId = (quotedMsg.wwebjsId || quotedMsg.wabaId)!;
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
				process.log(
					`Processando arquivo enviado diretamente: ${data.file.originalname}`
				);

				if (data.sendAsAudio) {
					process.log(
						"Mensagem de audio, convertendo arquivo para mp3."
					);
				}

				const buffer = data.sendAsAudio
					? await OpusAudioConverter.convert(data.file.buffer)
					: data.file.buffer;

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

				options = {
					...options,
					fileUrl,
					sendAsAudio: data.sendAsAudio,
					sendAsDocument: data.sendAsDocument
				} as SendFileOptions;

				message.fileId = savedFile.id;
				message.fileName = savedFile.name;
				message.fileType = savedFile.mime_type;
				message.fileSize = String(savedFile.size);

				message.type = getMessageType(
					data.file.mimetype,
					!!data.sendAsAudio,
					!!data.sendAsDocument
				);
				process.log("Arquivo processado com sucesso.", message);
			}

			process.log("Salvando mensagem no banco de dados.", message);
			const pendingMsg = await messagesService.insertMessage(message);
			process.log("Enviando mensagem para o cliente.");

			messagesDistributionService.notifyMessage(process, pendingMsg);
			const sentMsg = await client.sendMessage(options);
			process.log("Atualizando mensagem no banco de dados.", sentMsg);

			message = { ...pendingMsg, ...sentMsg, status: "SENT" };
			const savedMsg = await messagesService.updateMessage(
				pendingMsg.id,
				message
			);
			messagesDistributionService.notifyMessage(process, savedMsg);
			process.log("Mensagem salva no banco de dados.", savedMsg);
			process.success(savedMsg);

			return savedMsg;
		} catch (err) {
			console.error(err);
			process.failed(
				"Erro ao enviar mensagem: " + sanitizeErrorMessage(err)
			);
			throw new BadRequestError("Erro ao enviar mensagem.", err);
		}
	}

	public async sendBotMessage(to: string, data: SendBotMessageData) {
		const process = new ProcessingLogger(
			data.chat.instance,
			"send-bot-message",
			`${to}-${Date.now()}`,
			data
		);

		process.log("Iniciando o envio da mensagem.");
		try {
			process.log("Obtendo client do whatsapp...");
			const client = await this.getClientBySector(
				data.chat.instance,
				data.chat.sectorId || 1
			);
			process.log(
				`Client obtido para o setor: ${data.chat.sectorId || 1}`
			);
			let message = {
				instance: data.chat.instance,
				status: "PENDING",
				timestamp: Date.now().toString(),
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
				const quotedMsg =
					await prismaService.wppMessage.findUniqueOrThrow({
						where: {
							id: data.quotedId
						}
					});

				options.quotedId = (quotedMsg.wwebjsId || quotedMsg.wabaId)!;
				message.quotedId = quotedMsg.id;
			}
			process.log("Salvando mensagem no banco de dados.", message);
			const pendingMsg = await messagesService.insertMessage(message);
			process.log("Enviando mensagem para o cliente.");

			const sentMsg = await client.sendMessage(options);
			process.log("Atualizando mensagem no banco de dados.", sentMsg);

			message = { ...pendingMsg, ...sentMsg,from: `bot:${client.phone}`,status: "SENT" };

			const savedMsg = await messagesService.updateMessage(
				pendingMsg.id,
				message
			);
			process.log("Mensagem salva no banco de dados.", savedMsg);

			messagesDistributionService.notifyMessage(process, savedMsg);
			process.success(savedMsg);

			return savedMsg;
		} catch (err) {
			console.error(err);
			process.failed(
				"Erro ao enviar mensagem: " + sanitizeErrorMessage(err)
			);
			throw new BadRequestError("Erro ao enviar mensagem.", err);
		}
	}
	public async getResults(instance: string) {
		const query = "SELECT CODIGO AS id, NOME AS name FROM resultados";
		const result = await instancesService.executeQuery<
			{ id: number; name: string }[]
		>(instance, query, []);

		return result;
	}

	private unsafeGetWwebjsClient(
		instance: string
	): WWEBJSWhatsappClient | null {
		const correctClient = this.getWwebjsClient(instance);

		if (correctClient) {
			return correctClient;
		}

		const clients = this.clients.values();
		const wwebjsClient: WWEBJSWhatsappClient =
			(Array.from(clients).find(
				(client) =>
					client instanceof WWEBJSWhatsappClient && client.isReady
			) as WWEBJSWhatsappClient) || null;

		return wwebjsClient;
	}

	private getWwebjsClient(instance: string): WWEBJSWhatsappClient | null {
		const clients = this.clients.values();
		const wwebjsClient: WWEBJSWhatsappClient =
			(Array.from(clients).find(
				(client) =>
					client instanceof WWEBJSWhatsappClient &&
					client.instance === instance &&
					client.isReady
			) as WWEBJSWhatsappClient) || null;

		return wwebjsClient;
	}

	public async getValidWhatsappPhone(instance: string, phone: string) {
		const wwebjs = this.unsafeGetWwebjsClient(instance);
		const validPhone = wwebjs
			? await wwebjs?.getValidWhatsapp(phone)
			: null;

		return validPhone;
	}

	public async getProfilePictureUrl(instance: string, phone: string) {
		try {
			const wwebjs = this.unsafeGetWwebjsClient(instance);
			const url = wwebjs
				? await wwebjs?.getProfilePictureUrl(phone)
				: null;

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
}

export default new WhatsappService();
