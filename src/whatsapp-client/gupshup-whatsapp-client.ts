import axios from "axios";
import CreateMessageDto from "../dtos/create-message.dto";
import { EditMessageOptions, SendMessageOptions, SendTemplateOptions } from "../types/whatsapp-instance.types";
import WhatsappClient from "./whatsapp-client";
import { GSRecoverTemplatesResponse } from "../types/gupshup-api.types";
import ProcessingLogger from "../utils/processing-logger";
import { randomUUID } from "crypto";

const GUP_URL = "https://api.gupshup.io";

class GupshupWhatsappClient implements WhatsappClient {
	public readonly api: axios.AxiosInstance;

	constructor(
		public readonly id: number,
		public readonly instance: string,
		public readonly name: string,
		public readonly phone: string,
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

	public async sendMessage(options: SendMessageOptions): Promise<CreateMessageDto> {
		const logger = new ProcessingLogger(this.instance, "gs-send-message", randomUUID(), options);

		logger.log("[Gupshup] Iniciando envio de mensagem.");
		try {
			const data = new URLSearchParams();
			logger.log("[Gupshup] Montando parâmetros básicos.");

			data.append("channel", "whatsapp");
			data.append("src.name", this.appName);
			data.append("source", this.phone);
			data.append("destination", options.to);

			const msgType = (() => {
				if (!("fileUrl" in options)) return "text";
				if (!options.fileType || options.fileType === "document") return "file";
				return options.fileType;
			})();
			logger.log("[Gupshup] Tipo de mensagem determinado: " + msgType);

			let msg: any = {};

			if (options.quotedId) {
				logger.log("[Gupshup] Aplicando quotedId no contexto.");
				msg.context = { msgId: options.quotedId };
			}

			if ("fileUrl" in options) {
				const urlKey = options.fileType === "image" ? "originalUrl" : "url";
				const updatedFileUrl = options.fileUrl.replace(
					"http://localhost:8003",
					"https://inpulse.infotecrs.inf.br"
				);
				logger.log("[Gupshup] Montando payload de mídia.", updatedFileUrl);

				msg.type = msgType;
				msg[urlKey] = updatedFileUrl;

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
			const response = await this.api.post("/wa/api/v1/msg", data, {
				headers: { "Content-Type": "application/x-www-form-urlencoded" }
			});
			logger.log("[Gupshup] Resposta recebida da Gupshup.", { status: response.status });

			const now = new Date();
			const message: CreateMessageDto = {
				instance: this.instance,
				from: `me:${this.phone}`,
				to: options.to,
				body: options.text || "",
				status: "PENDING",
				timestamp: now.getTime().toString(),
				sentAt: now,
				type: msgType,
				wabaId: (response as any).data["messageId"] || null
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
			console.error(details);
			throw err;
		}
	}

	public async sendTemplate(options: SendTemplateOptions, chatId: number, contactId: number) {
		const data = new URLSearchParams();

		data.append("channel", "whatsapp");
		data.append("src.name", this.appName);
		data.append("source", this.phone);
		data.append("destination", options.to);
		data.append(
			"template",
			JSON.stringify({
				id: options.templateId,
				params: options.parameters || []
			})
		);

		const response = await this.api.post("/wa/api/v1/template/msg", data, {
			headers: {
				"Content-Type": "application/x-www-form-urlencoded"
			}
		});

		const text = options.templateText.replace(/{{(\d+)}}/g, (_, index) => {
			return options.parameters[parseInt(index, 10)] || "";
		});
		const now = new Date();

		const message: CreateMessageDto = {
			instance: this.instance,
			from: `me:${this.phone}`,
			to: options.to,
			body: text,
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

		return response.data.templates || [];
	}

	public async editMessage({ }: EditMessageOptions): Promise<void> {
		throw new Error("Method not implemented.");
	}
}

export default GupshupWhatsappClient;
