import { Logger } from "@in.pulse-crm/utils";
import axios from "axios";
import FormData from "form-data";
import TemplateAdapter from "../adapters/template.adapter";
import CreateMessageDto from "../dtos/create-message.dto";
import filesService from "../services/files.service";
import { TemplateVariables, WABAMessageTemplate, WABATemplateBodyComponent } from "../types/whatsapp-api.types";
import {
	EditMessageOptions,
	SendFileOptions,
	SendMessageOptions,
	SendTemplateOptions
} from "../types/whatsapp-instance.types";
import generateUID from "../utils/generate-uid";
import ProcessingLogger from "../utils/processing-logger";
import WhatsappClient from "./whatsapp-client";

interface GetTemplateVariablesProps {
	template: WABAMessageTemplate;
	variables: TemplateVariables;
}

const GRAPH_API_URL = "https://graph.facebook.com/v16.0/";

class WABAWhatsappClient implements WhatsappClient {
	constructor(
		public readonly id: number,
		public readonly instance: string,
		public readonly name: string,
		public readonly phone: string,
		private readonly wabaPhoneId: string,
		private readonly wabaAccountId: string,
		private readonly wabaToken: string
	) {
		Logger.info(
			[
				`WABA Client initialized for instance ${instance}!`,
				`Phone: ${phone}`,
				`WABA Account ID: ${this.wabaAccountId}`,
				`WABA Phone ID: ${this.wabaPhoneId}`
			].join("\n")
		);
	}

	public async getProfilePictureUrl(_: string): Promise<string | null> {
		throw new Error("Method not implemented.");
	}

	public async isValidWhatsapp(_: string): Promise<boolean> {
		throw new Error("Method not implemented.");
	}

	public async sendMessage(options: SendMessageOptions): Promise<CreateMessageDto> {
		const process = new ProcessingLogger(this.instance, "waba-send-message", generateUID(), options);

		try {
			process.log("Iniciando envio de mensagem...", options);
			const reqUrl = `${GRAPH_API_URL}/${this.wabaPhoneId}/messages`;
			const reqBody: any = {
				recipient_type: "individual",
				messaging_product: "whatsapp",
				to: options.to
			};

			const msgType = this.getSendMessageType(options);
			process.log("Tipo de mensagem determinado: " + msgType);

			if (msgType !== "text" && "file" in options) {
				process.log("Iniciando upload de mídia...", options.file);
				const uploadedFile = await this.uploadMediaFromFileId(options);
				process.log("Upload de mídia concluído.", uploadedFile);
				process.log("Montando corpo da mensagem de mídia...");
				reqBody["type"] = msgType;
				reqBody[msgType] = {
					id: uploadedFile.id,
					...(options.text ? { caption: options.text } : {}),
					...(msgType === "document" ? { filename: options.file.name } : {})
				};
			} else {
				process.log("Montando corpo da mensagem de texto...");
				reqBody["type"] = "text";
				reqBody["text"] = { body: options.text };
			}

			process.log("Enviando mensagem a Graph API...", { url: reqUrl, body: reqBody, options: this.reqOptions });
			const response = await axios.post(reqUrl, reqBody, this.reqOptions);
			process.log("Mensagem enviada com sucesso.", response.data);

			const now = new Date();
			const dto: CreateMessageDto = {
				instance: this.instance,
				from: `me:${this.phone}`,
				to: options.to,
				body: options.text || "",
				status: "PENDING",
				timestamp: now.getTime().toString(),
				sentAt: now,
				type: msgType,
				wabaId: response.data.messages[0].id
			};

			process.log("Processo concluído com sucesso.");
			process.success(dto);

			return dto;
		} catch (error) {
			process.log("Falha ao enviar mensagem...");
			process.failed(error);
			throw error;
		}
	}

	public async editMessage({}: EditMessageOptions): Promise<void> {
		throw new Error("Method not implemented.");
	}

	private get reqOptions() {
		return {
			headers: {
				Authorization: `Bearer ${this.wabaToken}`
			}
		};
	}

	private getSendMessageType(options: SendMessageOptions) {
		if ("file" in options) {
			return this.getSendFileType(options.file.mime_type, !!options.sendAsAudio, !!options.sendAsDocument);
		}

		return "text";
	}

	private getSendFileType(mimeType: string, sendAsAudio: boolean, sendAsDocument: boolean): string {
		if (sendAsAudio) return "audio";
		if (sendAsDocument) return "document";
		if (mimeType.startsWith("video/")) return "video";
		if (mimeType.startsWith("image/")) return "image";
		if (mimeType.startsWith("audio/")) return "audio";

		return "document";
	}

	private async uploadMediaFromFileId(options: SendFileOptions) {
		const processId = new Date().toISOString();
		const process = new ProcessingLogger(this.instance, "waba-upload-media", processId, options);
		try {
			process.log("Iniciando processo de upload de mídia...");
			const reqUrl = `${GRAPH_API_URL}/${this.wabaPhoneId}/media`;

			process.log(`Buscando arquivo ID ${options.file.id}...`);
			const fileBuffer = await filesService.fetchFile(options.file.id);
			process.log(`Arquivo ID ${options.file.id} buscado com sucesso.`);

			const form = new FormData();

			form.append("messaging_product", "whatsapp");
			form.append(
				"type",
				this.getSendFileType(options.file.mime_type, !!options.sendAsAudio, !!options.sendAsDocument)
			);
			form.append("file", fileBuffer, {
				filename: options.file.name,
				contentType: options.file.mime_type
			});

			const reqOptions = this.reqOptions;
			reqOptions.headers = { ...reqOptions.headers, ...form.getHeaders() };

			process.log("Enviando mídia a Graph API...", { url: reqUrl, options: reqOptions });
			const response = await axios.post(reqUrl, form, reqOptions);
			const output = { id: response.data.id };
			process.log("Upload de mídia concluído com sucesso.", output);
			return output;
		} catch (error) {
			process.log("Falha ao enviar mídia a Graph API...");
			process.failed(error);
			throw new Error("Falha ao enviar mídia a Graph API. Processo ID: " + processId);
		}
	}

	public async sendTemplate(
		options: SendTemplateOptions,
		chatId: number,
		contactId: number
	): Promise<CreateMessageDto> {
		const process = new ProcessingLogger(this.instance, "waba-send-template-message", generateUID(), {
			options,
			chatId,
			contactId
		});

		try {
			process.log("Iniciando envio de mensagem de template...");
			const requestURL = `https://graph.facebook.com/v16.0/${this.wabaPhoneId}/messages/`;
			const components = this.getTemplateVariables({
				template: options.template.raw,
				variables: options.templateVariables
			});
			process.log("Componentes do template processados.", components);

			const body = {
				messaging_product: "whatsapp",
				recipient_type: "individual",
				to: options.to,
				type: "template",
				template: {
					name: options.template.name,
					language: {
						code: options.template.raw.language
					},
					components
				}
			};
			process.log("Enviando mensagem de template a Graph API...", {
				url: requestURL,
				body,
				options: this.reqOptions
			});

			const response = await axios.post(requestURL, body, this.reqOptions);
			const replacedText = (options.template.raw.components as WABATemplateBodyComponent[])
				.map((c, i) => {
					let text = c.text;
					components[i]?.parameters.forEach((p, pi) => {
						text = text.replaceAll(`{{${pi + 1}}}`, p.text);
					});

					return text;
				})
				.join("\n");

			const now = new Date();
			const message: CreateMessageDto = {
				instance: this.instance,
				from: `me:${this.phone}`,
				to: options.to,
				body: replacedText,
				status: "PENDING",
				timestamp: now.getTime().toString(),
				sentAt: now,
				type: "template",
				wabaId: response.data.messages[0].id as string,
				chatId,
				contactId
			};
			process.log("Mensagem de template enviada com sucesso.");
			process.success(message);
			return message;
		} catch (error) {
			process.log("Falha ao enviar mensagem de template...");
			process.failed(error);
			throw error;
		}
	}

	private getTemplateVariables({ template, variables }: GetTemplateVariablesProps) {
		const templateComponents = template.components;

		const formatedVars = templateComponents.map((c) => {
			if (
				c.type === "HEADER" &&
				c.example &&
				Array.isArray(c.example.header_text) &&
				c.example.header_text[0] !== undefined
			) {
				const key = c.example.header_text[0];
				const parameter = (variables as unknown as Record<string, string>)[key] || "Undefined";

				return {
					type: "header",
					parameters: [{ type: "text", text: parameter }]
				};
			} else if (
				c.type === "BODY" &&
				c.example &&
				Array.isArray(c.example.body_text) &&
				c.example.body_text[0] !== undefined
			) {
				const parameters: string[] = [];

				for (let s of c.example.body_text[0]) {
					const parameter = (variables as unknown as Record<string, string>)[s] || "Undefined";
					parameters.push(parameter);
				}

				if (parameters.length > 0) {
					return {
						type: "body",
						parameters: parameters.map((p) => ({ type: "text", text: p }))
					};
				}
			}
			// Explicitly return undefined for code paths that do not match above
			return undefined;
		});

		// Filter out undefined values
		return formatedVars.filter((v) => v !== undefined);
	}
	/* 	private validateSupportedMediaType(mimeType: string, extension: string): void {
			const supportedTypes = [
				// Áudio
				{ mime: 'audio/aac', ext: '.aac' },
				{ mime: 'audio/amr', ext: '.amr' },
				{ mime: 'audio/mpeg', ext: '.mp3' },
				{ mime: 'audio/mp4', ext: '.m4a' },
				{ mime: 'audio/ogg', ext: '.ogg' },
				// Documentos
				{ mime: 'text/plain', ext: '.txt' },
				{ mime: 'application/vnd.ms-excel', ext: '.xls' },
				{ mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
				{ mime: 'application/msword', ext: '.doc' },
				{ mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
				{ mime: 'application/vnd.ms-powerpoint', ext: '.ppt' },
				{ mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
				{ mime: 'application/pdf', ext: '.pdf' },
				// Imagens
				{ mime: 'image/jpeg', ext: '.jpeg' },
				{ mime: 'image/png', ext: '.png' },
				// Stickers
				{ mime: 'image/webp', ext: '.webp' },
				// Vídeo
				{ mime: 'video/3gpp', ext: '.3gp' },
				{ mime: 'video/mp4', ext: '.mp4' },
			];
	
			const found = supportedTypes.some(type =>
				type.mime === mimeType && extension.toLowerCase().endsWith(type.ext)
			);
			if (!found) {
				throw new Error(`Tipo de mídia não suportado: ${mimeType} (${extension})`);
			}
		} */

	public async getTemplates(): Promise<any> {
		const requestURL = `https://graph.facebook.com/v16.0/${this.wabaAccountId}/message_templates?limit=999`;
		const response = await axios.get(requestURL, this.reqOptions);
		const templates = response.data.data;

		return templates.map((t: WABAMessageTemplate) => TemplateAdapter.fromWABATemplate(t));
	}
}

export default WABAWhatsappClient;
