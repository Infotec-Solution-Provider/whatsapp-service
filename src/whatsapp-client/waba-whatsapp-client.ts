import { Logger } from "@in.pulse-crm/utils";
import axios, { AxiosError } from "axios";
import FormData from "form-data";
import TemplateAdapter from "../adapters/template.adapter";
import CreateMessageDto from "../dtos/create-message.dto";
import filesService from "../services/files.service";
import prismaService from "../services/prisma.service";
import { TemplateVariables, WABAMessageTemplate, WABATemplateBodyComponent } from "../types/whatsapp-api.types";
import {
	EditMessageOptions,
	SendFileOptions,
	SendMessageOptions,
	SendTemplateOptions,
	WhatsappGroup
} from "../types/whatsapp-instance.types";
import generateUID from "../utils/generate-uid";
import ProcessingLogger from "../utils/processing-logger";
import WhatsappClient from "./whatsapp-client";

interface GetTemplateVariablesProps {
	template: WABAMessageTemplate;
	variables: TemplateVariables;
}

const GRAPH_API_URL = "https://graph.facebook.com/v16.0";

class WABAWhatsappClient implements WhatsappClient {
	constructor(
		public readonly id: number,
		public readonly instance: string,
		public readonly name: string,
		public readonly _phone: string,
		private readonly wabaPhoneId: string,
		private readonly wabaAccountId: string,
		private readonly wabaToken: string
	) {
		Logger.info(
			[
				`WABA Client initialized for instance ${instance}!`,
				`Phone: ${_phone}`,
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

			let msgType = this.getSendMessageType(options);
			process.log("Tipo de mensagem determinado: " + msgType);

			if (msgType !== "text" && "fileId" in options) {
				process.log("Iniciando upload de mídia...", options.fileId);
				try {
					const uploadedFile = await this.uploadMediaFromFileId(options);
					process.log("Upload de mídia concluído.", uploadedFile);
					process.log("Montando corpo da mensagem de mídia...");
					reqBody["type"] = msgType;

					if (msgType === "audio") {
						options.text = null;
					}

					reqBody[msgType] = {
						id: uploadedFile.id,
						...(options.text ? { caption: options.text } : {}),
						...(msgType === "document" ? { filename: options.file.name } : {})
					};
				} catch (uploadError) {
					const fallbackText = options.text
						? `${options.text}\n\n${options.publicFileUrl}`
						: `${options.publicFileUrl}`;

					process.log("Falha no upload de mídia. Aplicando fallback de URL para download.", {
						fileId: options.fileId,
						publicFileUrl: options.publicFileUrl,
						error: uploadError instanceof Error ? uploadError.message : uploadError
					});

					msgType = "text";
					options.text = fallbackText;
					reqBody["type"] = "text";
					reqBody["text"] = { body: fallbackText };
				}
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
				clientId: this.id,
				instance: this.instance,
				from: `me:${this._phone}`,
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
		} catch (error: any) {
			if (error instanceof AxiosError) {
				Logger.error("Erro na requisição Axios:", error.response?.data || error.message);
			} else {
				Logger.error("Erro ao enviar mensagem via WABA:", error);
			}
			process.log("Falha ao enviar mensagem...");
			process.failed(error);
			throw error;
		}
	}

	public async editMessage({ }: EditMessageOptions): Promise<void> {
		throw new Error("Method not implemented.");
	}

	public async forwardMessage(to: string, messageId: string, isGroup: boolean = false): Promise<void> {
		const process = new ProcessingLogger(this.instance, "waba-forward-message", generateUID(), {
			to,
			messageId,
			isGroup
		});

		try {
			process.log("Iniciando forward simulado - buscando mensagem original");

			// Busca a mensagem original
			const originalMessage = await prismaService.wppMessage.findFirst({
				where: {
					OR: [{ wabaId: messageId }, { gupshupId: messageId }, { wwebjsId: messageId }]
				}
			});

			if (!originalMessage) {
				throw new Error(`Mensagem não encontrada para forward: ${messageId}`);
			}

			process.log("Mensagem original encontrada", {
				id: originalMessage.id,
				type: originalMessage.type,
				hasFile: !!originalMessage.fileId
			});

			// Monta as opções de envio baseado na mensagem original
			let sendOptions: SendMessageOptions;

			if (originalMessage.fileId) {
				process.log("Preparando forward de mídia - buscando metadados do arquivo");

				const fileMetadata = await filesService.fetchFileMetadata(originalMessage.fileId);

				sendOptions = {
					to,
					text: originalMessage.body,
					fileId: originalMessage.fileId,
					localFileUrl: filesService.getFileDownloadUrl(originalMessage.fileId),
					publicFileUrl: `https://inpulse.infotecrs.inf.br/public/${this.instance}/files/${fileMetadata.public_id}`,
					sendAsAudio: originalMessage.type === "ptt",
					sendAsDocument: originalMessage.type === "document",
					file: fileMetadata
				} satisfies SendFileOptions;

				process.log("Opções de envio de mídia preparadas", sendOptions);
			} else {
				sendOptions = {
					to,
					text: originalMessage.body || ""
				};
				process.log("Preparando forward de texto", sendOptions);
			}

			process.log("Enviando mensagem forward...");
			await this.sendMessage(sendOptions);
			process.log("Forward simulado concluído com sucesso");
			process.success("Forward message completed");
		} catch (error) {
			process.log("Erro no forward simulado", error);
			process.failed(error);
			throw error;
		}
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

			process.log(`Buscando arquivo ID ${options.fileId}...`);
			const fileBuffer = await filesService.fetchFile(options.fileId);
			process.log(`Arquivo ID ${options.fileId} buscado com sucesso.`);

			const form = new FormData();

			form.append("messaging_product", "whatsapp");
			form.append("type", options.file.mime_type);
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
			process.log("Falha ao enviar mídia a META Api...");
			process.failed(error);
			let metaErrorDetails = "";
			if (error instanceof AxiosError) {
				const responseData = error.response?.data;
				const metaError = responseData?.error;
				if (metaError) {
					metaErrorDetails = metaError.message ? ` Detalhes: ${metaError.message}` : "";
				} else {
					metaErrorDetails = responseData ? ` Detalhes: ${JSON.stringify(responseData)}` : "";
				}
			}
			throw new Error(
				"Erro ao enviar mídia a META Api. ID: " + processId + metaErrorDetails
			);
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
				clientId: this.id,
				instance: this.instance,
				from: `me:${this._phone}`,
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

	public async getTemplates(): Promise<any> {
		const requestURL = `https://graph.facebook.com/v16.0/${this.wabaAccountId}/message_templates?limit=999`;
		const response = await axios.get(requestURL, this.reqOptions);
		const templates = response.data.data;

		return templates.map((t: WABAMessageTemplate) => TemplateAdapter.fromWABATemplate(t));
	}

	public async getGroups(): Promise<WhatsappGroup[]> {
		return [];
	}
}

export default WABAWhatsappClient;
