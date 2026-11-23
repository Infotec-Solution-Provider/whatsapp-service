import { Logger } from "@in.pulse-crm/utils";
import axios, { AxiosError } from "axios";
import TemplateAdapter, { TemplateMessage } from "../adapters/template.adapter";
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

const GRAPH_VERSION = process.env["WABA_GRAPH_API_VERSION"] || "v27.0";
if (!/^v\d+\.0$/.test(GRAPH_VERSION)) throw new Error("WABA_GRAPH_API_VERSION inválida.");
const GRAPH_API_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

class WABAWhatsappClient implements WhatsappClient {
	private ciagTemplatesCache: { expires: number; templates: TemplateMessage[] } | undefined;
	public async getCiagTemplates(refresh = false) {
		if (!refresh && this.ciagTemplatesCache && this.ciagTemplatesCache.expires > Date.now())
			return this.ciagTemplatesCache.templates;
		const templates = await this.getTemplates();
		this.ciagTemplatesCache = { expires: Date.now() + 60_000, templates };
		return templates;
	}
	public async verifyConnection() {
		await axios.get(`${GRAPH_API_URL}/${this.wabaPhoneId}`, {
			...this.reqOptions,
			params: { fields: "id,display_phone_number" }
		});
	}

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
		return null;
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
				const fileSize = this.parseFileSizeBytes(options.file.size);

				const mime = options.file.mime_type;
				const limit = mime.startsWith("image/")
					? 5
					: mime.startsWith("audio/") || mime.startsWith("video/")
						? 16
						: 100;
				if (fileSize === null || fileSize > limit * 1024 * 1024)
					throw new Error(`Arquivo excede o limite de ${limit} MB.`);
				const mediaId = await filesService.getWabaMedia(options.fileId);
				reqBody["type"] = msgType;
				reqBody[msgType] = {
					id: mediaId,
					...(msgType === "audio"
						? options.sendAsAudio
							? { voice: true }
							: {}
						: options.text
							? { caption: options.text }
							: {}),
					...(msgType === "document" ? { filename: options.file.name } : {})
				};
			} else {
				process.log("Montando corpo da mensagem de texto...");
				reqBody["type"] = "text";
				reqBody["text"] = { body: options.text };
			}

			process.log("Enviando mensagem a Graph API...", {
				url: reqUrl,
				body: reqBody,
				authorization: "[redacted]"
			});
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
				wabaId: response.data.messages[0].id,
				...("file" in options
					? {
							fileId: options.fileId,
							fileName: options.file.name,
							fileType: options.file.mime_type,
							fileSize: String(options.file.size)
						}
					: {})
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
			process.failed(new Error(error instanceof Error ? error.message : "Falha WABA"));
			throw error;
		}
	}

	public async editMessage({}: EditMessageOptions): Promise<void> {
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
					publicFileUrl: filesService.getPublicFileUrl(this.instance, fileMetadata.public_id),
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
			process.failed(new Error(error instanceof Error ? error.message : "Falha WABA"));
			throw error;
		}
	}

	private get reqOptions() {
		return {
			headers: {
				Authorization: `Bearer ${this.wabaToken}`
			},
			timeout: 30_000
		};
	}

	private getSendMessageType(options: SendMessageOptions) {
		if ("file" in options) {
			return this.getSendFileType(options.file.mime_type);
		}

		return "text";
	}

	private getSendFileType(mimeType: string): string {
		if (mimeType.startsWith("video/")) return "video";
		if (mimeType.startsWith("image/")) return "image";
		if (mimeType.startsWith("audio/")) return "audio";

		return "document";
	}

	private parseFileSizeBytes(size: unknown): number | null {
		if (typeof size === "number" && Number.isFinite(size)) {
			return size;
		}

		if (typeof size === "string") {
			const parsed = Number(size);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}

		return null;
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
			const requestURL = `${GRAPH_API_URL}/${this.wabaPhoneId}/messages`;
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
						code: options.template.language
					},
					components
				}
			};
			process.log("Enviando mensagem de template a Graph API...", {
				url: requestURL,
				body,
				authorization: "[redacted]"
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
			process.failed(new Error(error instanceof Error ? error.message : "Falha WABA"));
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

	public async getTemplates(): Promise<import("../adapters/template.adapter").TemplateMessage[]> {
		const templates: WABAMessageTemplate[] = [];
		let after: string | undefined;
		do {
			const response = await axios.get(`${GRAPH_API_URL}/${this.wabaAccountId}/message_templates`, {
				...this.reqOptions,
				params: { limit: 100, ...(after ? { after } : {}) }
			});
			templates.push(...response.data.data);
			after = response.data.paging?.next ? response.data.paging?.cursors?.after : undefined;
			if (templates.length > 10_000) throw new Error("Quantidade de modelos acima do limite de sincronização.");
		} while (after);
		return templates.map((t) => TemplateAdapter.fromWABATemplate(t));
	}

	public async buildCiagTemplate(name: string, language: string, variables: Record<string, string>, fileId?: number) {
		const template = (await this.getCiagTemplates()).find(
			(t) => t.name === name && t.language === language && t.status === "APPROVED"
		);
		if (!template) throw Object.assign(new Error("Modelo não aprovado ou indisponível."), { status: 400 });
		const components: Array<Record<string, unknown>> = [];
		const parameter = (key: string) => {
			const value = variables[key];
			if (!value) throw Object.assign(new Error(`Preencha a variável ${key}.`), { status: 400 });
			return value;
		};
		let attachmentUsed = false;
		for (const component of template.raw.components as Array<{
			type: string;
			format?: string;
			text?: string;
			buttons?: Array<{ type: string; url?: string }>;
		}>) {
			const type = component.type.toLowerCase();
			if (type === "header" && ["IMAGE", "DOCUMENT", "VIDEO"].includes(component.format || "")) {
				if (!fileId) throw Object.assign(new Error("O modelo exige um anexo."), { status: 400 });
				const file = await filesService.fetchFileMetadata(fileId);
				const expected =
					component.format === "IMAGE" ? "image/" : component.format === "VIDEO" ? "video/" : "application/";
				if (
					!(
						file.mime_type.startsWith(expected) ||
						(component.format === "DOCUMENT" && file.mime_type === "text/plain")
					)
				)
					throw Object.assign(new Error("Anexo incompatível com o cabeçalho do modelo."), { status: 400 });
				const mediaType = component.format!.toLowerCase();
				components.push({
					type: "header",
					parameters: [
						{
							type: mediaType,
							[mediaType]: {
								id: await filesService.getWabaMedia(fileId),
								...(mediaType === "document" ? { filename: file.name } : {})
							}
						}
					]
				});
				attachmentUsed = true;
			} else if (type === "header" || type === "body") {
				const keys = [
					...new Set([...(component.text || "").matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]!))
				];
				if (keys.length)
					components.push({
						type,
						parameters: keys.map((key) => ({
							type: "text",
							text: parameter(`${type}:${key}`),
							...(/^\d+$/.test(key) ? {} : { parameter_name: key })
						}))
					});
			} else if (type === "buttons") {
				component.buttons?.forEach((button, index) => {
					const keys = [
						...new Set([...(button.url || "").matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]!))
					];
					if (button.type === "URL" && keys.length)
						components.push({
							type: "button",
							sub_type: "url",
							index: String(index),
							parameters: keys.map((key) => ({ type: "text", text: parameter(`button:${index}:${key}`) }))
						});
					if (button.type === "COPY_CODE")
						components.push({
							type: "button",
							sub_type: "copy_code",
							index: String(index),
							parameters: [{ type: "coupon_code", coupon_code: parameter(`button:${index}:coupon_code`) }]
						});
				});
			}
		}
		if (fileId && !attachmentUsed) throw Object.assign(new Error("Este modelo não aceita anexo."), { status: 400 });
		return { template, components };
	}

	public async sendCiagTemplate(
		to: string,
		name: string,
		language: string,
		variables: Record<string, string>,
		chatId: number,
		contactId: number,
		fileId?: number
	): Promise<CreateMessageDto> {
		const { template, components } = await this.buildCiagTemplate(name, language, variables, fileId);
		const response = await axios.post(
			`${GRAPH_API_URL}/${this.wabaPhoneId}/messages`,
			{
				messaging_product: "whatsapp",
				to,
				type: "template",
				template: { name, language: { code: language }, components }
			},
			this.reqOptions
		);
		const now = new Date();
		const body = (template.raw.components as Array<{ type: string; text?: string }>)
			.filter((c) => c.text)
			.map((c) =>
				c.text!.replace(
					/\{\{([a-zA-Z0-9_]+)\}\}/g,
					(_match, key: string) => variables[`${c.type.toLowerCase()}:${key}`] || ""
				)
			)
			.join("\n");
		const media = fileId ? await filesService.fetchFileMetadata(fileId) : null;
		return {
			clientId: this.id,
			instance: this.instance,
			from: `me:${this._phone}`,
			to,
			body,
			status: "SENT",
			timestamp: String(now.getTime()),
			sentAt: now,
			type: "template",
			wabaId: response.data.messages[0].id,
			chatId,
			contactId,
			...(media
				? { fileId: media.id, fileName: media.name, fileType: media.mime_type, fileSize: String(media.size) }
				: {})
		};
	}

	public async getGroups(): Promise<WhatsappGroup[]> {
		return [];
	}
}

export default WABAWhatsappClient;
