import axios from "axios";
import CreateMessageDto from "../dtos/create-message.dto";
import {
	SendMessageOptions,
	SendTemplateOptions
} from "../types/whatsapp-instance.types";
import WhatsappClient from "./whatsapp-client";
import { GSRecoverTemplatesResponse } from "../types/gupshup-api.types";

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

	public async sendMessage(
		options: SendMessageOptions
	): Promise<CreateMessageDto> {
		//const response = await this.api.post("/wa/api/v1/msg");
		const data = new URLSearchParams();

		data.append("channel", "whatsapp");
		data.append("src.name", this.appName);
		data.append("source", this.phone);
		data.append("destination", options.to);

		if ("fileUrl" in options) {
			const urlKey = options.fileType === "image" ? "originalUrl" : "url";
			const updatedFileUrl = options.fileUrl.replace(
				"http://localhost:8003",
				"https://inpulse.infotecrs.inf.br"
			);

			let message = {
				type: options.fileType || "document",
				[urlKey]: updatedFileUrl
			};

			if (options.text && !options.sendAsAudio) {
				message["caption"] = options.text;
			}

			data.append("message", JSON.stringify(message));
		} else {
			if (!("text" in options)) {
				throw new Error("Text is required for text messages");
			}

			let message = {
				type: "text",
				text: options.text
			};
			data.append("message", JSON.stringify(message));
		}

		console.log(data);

		const response = await this.api
			.post("/wa/api/v1/msg", data, {
				headers: {
					"Content-Type": "application/x-www-form-urlencoded"
				}
			})
			.catch((err) => {
				console.error(err.response.data);
				throw new Error("F");
			});

		const msgType = (() => {
			if (!("fileUrl" in options)) {
				return "text";
			}

			if ((!options.fileType) || options.fileType === "document") {
				return "file";
			}

			return options.fileType;
		})()

		const message: CreateMessageDto = {
			instance: this.instance,
			from: `me:${this.phone}`,
			to: options.to,
			body: options.text || "",
			status: "PENDING",
			timestamp: Date.now().toString(),
			type: msgType,
			wabaId: response.data["messageId"] || null
		};

		if ("file" in options) {
			message.fileId = options.file.id;
			message.fileName = options.file.name;
			message.fileType = options.file.mime_type;
			message.fileSize = options.file.size?.toString() || null;
		}

		return message;
	}

	public async sendTemplate(
		options: SendTemplateOptions,
		chatId: number,
		contactId: number
	) {
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

		const message: CreateMessageDto = {
			instance: this.instance,
			from: `me:${this.phone}`,
			to: options.to,
			body: text,
			status: "SENT",
			timestamp: Date.now().toString(),
			type: "template",
			wabaId: response.data["messageId"] || null,
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
}

export default GupshupWhatsappClient;
