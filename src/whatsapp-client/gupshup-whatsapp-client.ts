import axios from "axios";
import { randomUUID } from "crypto";
import TemplateAdapter from "../adapters/template.adapter";
import CreateMessageDto from "../dtos/create-message.dto";
import filesService from "../services/files.service";
import prismaService from "../services/prisma.service";
import { GSRecoverTemplatesResponse } from "../types/gupshup-api.types";
import { EditMessageOptions, SendMessageOptions, SendTemplateOptions, WhatsappGroup } from "../types/whatsapp-instance.types";
import ProcessingLogger from "../utils/processing-logger";
import WhatsappClient from "./whatsapp-client";

const GUP_URL = "https://api.gupshup.io";

class GupshupWhatsappClient implements WhatsappClient {
	public readonly api: axios.AxiosInstance;

	constructor(
		public readonly id: number,
		public readonly instance: string,
		public readonly name: string,
		public readonly _phone: string,
		private readonly apiKey: string,
		private readonly appName: string,
		private readonly appId: string
	) {
		this.api = axios.create({
			baseURL: GUP_URL,
			headers: {
				apikey: this.apiKey
			}
		});
	}

	public async getProfilePictureUrl(_: string): Promise<string | null> {
		throw new Error("Method not implemented.");
	}

	public async isValidWhatsapp(_: string): Promise<boolean> {
		throw new Error("Method not implemented.");
	}

	private getSendType(options: SendMessageOptions): "text" | "image" | "video" | "audio" | "file" {
		if ("file" in options) {
			if (options.sendAsDocument) {
				return "file";
			}
			if (options.sendAsAudio || options.file.mime_type.startsWith("audio/")) {
				return "audio";
			}
			if (options.file.mime_type.startsWith("image/")) {
				return "image";
			}
			if (options.file.mime_type.startsWith("video/")) {
				return "video";
			}

			return "file";
		}
		return "text";
	}

	public async sendMessage(options: SendMessageOptions): Promise<CreateMessageDto> {
		const logger = new ProcessingLogger(this.instance, "gs-send-message", randomUUID(), options);

		logger.log("[Gupshup] Iniciando envio de mensagem.");
		try {
			const data = new URLSearchParams();
			logger.log("[Gupshup] Montando parâmetros básicos.");

			data.append("channel", "whatsapp");
			data.append("src.name", this.appName);
			data.append("source", this._phone);
			data.append("destination", options.to);

			let msgType = this.getSendType(options);
			logger.log("[Gupshup] Tipo de mensagem determinado: " + msgType);

			let msg: any = {};

			if (options.quotedId) {
				logger.log("[Gupshup] Aplicando quotedId no contexto.");
				msg.context = { msgId: options.quotedId };
			}

			if ("publicFileUrl" in options) {
				const urlKey = msgType === "image" ? "originalUrl" : "url";
				logger.log("[Gupshup] Montando payload de mídia.", options.publicFileUrl);
				msg.type = msgType;
				msg[urlKey] = options.publicFileUrl.replace("https://inpulse", "https://lux");

				if (options.text && !options.sendAsAudio && msgType !== "file") {
					msg["caption"] = options.text;
				}

				data.append("message", JSON.stringify(msg));
				logger.log("[Gupshup] Payload de mídia pronto.");
			} else {
				if (!("text" in options)) {
					logger.failed("Texto é obrigatório para mensagens de texto.");
					throw new Error("Text is required for text msgs");
				}

				msg.type = "text";
				msg.text = options.text;

				data.append("message", JSON.stringify(msg));
				logger.log("[Gupshup] Payload de texto pronto.");
			}

			logger.log("[Gupshup] Enviando requisição para Gupshup.", data.toString());
			let response;

			try {
				response = await this.api.post("/wa/api/v1/msg", data, {
					headers: { "Content-Type": "application/x-www-form-urlencoded" }
				});
			} catch (mediaError: any) {
				if (!("publicFileUrl" in options)) {
					throw mediaError;
				}

				const fallbackText = options.text ? `${options.text}\n\n${options.publicFileUrl}` : options.publicFileUrl;

				logger.log("[Gupshup] Falha no envio de mídia. Aplicando fallback para texto com link.", {
					fileId: options.file.id,
					fileDownloadUrl: options.publicFileUrl,
					error: mediaError?.response?.data || mediaError?.message || String(mediaError)
				});

				const fallbackData = new URLSearchParams();
				fallbackData.append("channel", "whatsapp");
				fallbackData.append("src.name", this.appName);
				fallbackData.append("source", this._phone);
				fallbackData.append("destination", options.to);

				const fallbackMessage: any = { type: "text", text: fallbackText };
				if (options.quotedId) {
					fallbackMessage.context = { msgId: options.quotedId };
				}

				fallbackData.append("message", JSON.stringify(fallbackMessage));
				response = await this.api.post("/wa/api/v1/msg", fallbackData, {
					headers: { "Content-Type": "application/x-www-form-urlencoded" }
				});

				msgType = "text";
				options.text = fallbackText;
			}
			logger.log("[Gupshup] Resposta recebida da Gupshup.", { status: response.status });

			const now = new Date();
			const message: CreateMessageDto = {
				clientId: this.id,
				instance: this.instance,
				from: `me:${this._phone}`,
				to: options.to,
				body: options.text || "",
				status: "PENDING",
				timestamp: now.getTime().toString(),
				sentAt: now,
				type: msgType,
				gupshupId: (response as any).data["messageId"] || null
			};

			if ("file" in options) {
				message.fileId = options.file.id;
				message.fileName = options.file.name;
				message.fileType = options.file.mime_type;
				message.fileSize = options.file.size?.toString() || null;
				logger.log("[Gupshup] Metadados de arquivo aplicados ao retorno.");
			}

			logger.log("[Gupshup] Mensagem preparada com sucesso.", message);
			logger.success(message);
			return message;
		} catch (err: any) {
			const details = err?.response?.data || err?.message || String(err);
			logger.log("[Gupshup] Erro ao enviar mensagem.", details);
			logger.failed(details);

			throw err;
		}
	}

	public async sendTemplate(options: SendTemplateOptions, chatId: number, contactId: number) {
		const data = new URLSearchParams();

		data.append("channel", "whatsapp");
		data.append("src.name", this.appName);
		data.append("source", this._phone);
		data.append("destination", options.to);
		data.append(
			"template",
			JSON.stringify({
				id: options.template.id,
				params: options.components
			})
		);

		const response = await this.api.post("/wa/api/v1/template/msg", data, {
			headers: {
				"Content-Type": "application/x-www-form-urlencoded"
			}
		});

		let replacedText = options.template.text;
		options.components.forEach((param, index) => {
			const placeholder = `{{${index + 1}}}`;
			replacedText = replacedText.replace(placeholder, param);
		});

		const now = new Date();

		const message: CreateMessageDto = {
			clientId: this.id,
			instance: this.instance,
			from: `me:${this._phone}`,
			to: options.to,
			body: replacedText,
			status: "SENT",
			timestamp: now.getTime().toString(),
			sentAt: now,
			type: "template",
			gupshupId: (response as any).data["messageId"] || null,
			chatId,
			contactId
		};

		return message;
	}

	public async getTemplates() {
		const response = await this.api.get<GSRecoverTemplatesResponse>(
			`/wa/app/${this.appId}/template?templateStatus=APPROVED`
		);

		if (response.status !== 200) {
			throw new Error("Failed to fetch templates from Gupshup.");
		}

		const mapped = response.data.templates.map((t) => TemplateAdapter.fromGupshupTemplate(t));

		return mapped;
	}

	public async editMessage({ }: EditMessageOptions): Promise<void> {
		throw new Error("Method not implemented.");
	}

	public async forwardMessage(to: string, messageId: string, isGroup: boolean = false): Promise<void> {
		const logger = new ProcessingLogger(this.instance, "gs-forward-message", randomUUID(), {
			to,
			messageId,
			isGroup
		});

		try {
			logger.log("[Gupshup] Iniciando forward simulado - buscando mensagem original");

			// Busca a mensagem original
			const originalMessage = await prismaService.wppMessage.findFirst({
				where: {
					OR: [{ gupshupId: messageId }, { wabaId: messageId }, { wwebjsId: messageId }]
				}
			});

			if (!originalMessage) {
				throw new Error(`Mensagem não encontrada para forward: ${messageId}`);
			}

			logger.log("[Gupshup] Mensagem original encontrada", {
				id: originalMessage.id,
				type: originalMessage.type,
				hasFile: !!originalMessage.fileId
			});

			// Monta as opções de envio baseado na mensagem original
			let sendOptions: SendMessageOptions;

			if (originalMessage.fileId) {
				// Mensagem com arquivo - reutiliza o arquivo existente
				logger.log("[Gupshup] Preparando forward de mídia");

				const fileMetadata = await filesService.fetchFileMetadata(originalMessage.fileId);

				sendOptions = {
					to,
					text: originalMessage.body ?? null,
					sendAsAudio: originalMessage.type === "ptt" || originalMessage.type === "audio",
					sendAsDocument: originalMessage.type === "document",
					file: fileMetadata,
					fileId: originalMessage.fileId,
					localFileUrl: filesService.getFileDownloadUrl(originalMessage.fileId),
					publicFileUrl: `https://inpulse.infotecrs.inf.br/public/${this.instance}/files/${fileMetadata.public_id}`,
				};
			} else {
				// Mensagem de texto
				logger.log("[Gupshup] Preparando forward de texto");
				sendOptions = {
					to,
					text: originalMessage.body || ""
				};
			}

			// Envia a mensagem
			await this.sendMessage(sendOptions);
			logger.log("[Gupshup] Forward simulado concluído com sucesso");
		} catch (error) {
			logger.log("[Gupshup] Erro no forward simulado", error);
			logger.failed(error);
			throw error;
		}
	}

	public async getGroups(): Promise<WhatsappGroup[]> {
		return [];
	}
}

export default GupshupWhatsappClient;
