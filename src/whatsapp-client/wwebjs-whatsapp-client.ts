import { SocketEventType, SocketServerAdminRoom } from "@in.pulse-crm/sdk";
import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import WAWebJS, { Client, LocalAuth } from "whatsapp-web.js";
import CreateMessageDto from "../dtos/create-message.dto";
import MessageParser from "../parsers/wwebjs-message.parser";
import runFixLidMessagesRoutine from "../routines/fix-lid-messages.routine";
import internalChatsService from "../services/internal-chats.service";
import messagesDistributionService from "../services/messages-distribution.service";
import messagesService from "../services/messages.service";
import prismaService from "../services/prisma.service";
import socketService from "../services/socket.service";
import {
	EditMessageOptions,
	Mentions,
	SendMessageOptions,
	SendTemplateOptions
} from "../types/whatsapp-instance.types";
import ProcessingLogger from "../utils/processing-logger";
import WhatsappClient from "./whatsapp-client";

const PUPPETEER_ARGS = {
	headless: true,
	args: [
		"--no-sandbox",
		"--disable-setuid-sandbox",
		"--disable-dev-shm-usage",
		"--disable-accelerated-2d-canvas",
		"--no-first-run",
		"--no-zygote",
		"--disable-gpu"
	]
};

const IGNORED_MESSAGE_TYPES = process.env["WWEBJS_IGNORED_MESSAGE_TYPES"]?.split(",") || [];
const BROWSER_PATH = process.env["WWEBJS_BROWSER_PATH"]!;

class WWEBJSWhatsappClient implements WhatsappClient {
	public wwebjs: Client;
	public isReady: boolean = false;

	constructor(
		public readonly id: number,
		public readonly instance: string,
		public readonly name: string
	) {
		this.wwebjs = new Client({
			authStrategy: new LocalAuth({
				clientId: `${this.instance}_${this.name}`
			}),
			puppeteer: {
				...PUPPETEER_ARGS,
				executablePath: BROWSER_PATH
			}
		});

		// Log events
		this.buildEvents(instance, id);

		this.wwebjs.initialize().catch((err) => {
			Logger.error(`Error initializing client: ${sanitizeErrorMessage(err)}`);
		});
	}

	get phone(): string {
		return this.wwebjs.info.wid.user;
	}

	private buildEvents(instance: string, id: number) {
		const instanceAndId = `${instance}:${id}`;

		this.wwebjs.on("change_state", (s) => {
			Logger.info(`[${instanceAndId}] State changed: ${s}`);
		});
		this.wwebjs.on("disconnected", (r) => {
			Logger.info(`[${instanceAndId}] Disconnected: ${r}`);
		});
		this.wwebjs.on("auth_failure", (m) => {
			Logger.info(`[${instanceAndId}] Auth failure: ${m}`);
		});
		this.wwebjs.on("loading_screen", (p, m) => {
			Logger.info(`[${instanceAndId}] Loading: ${p}% | ${m}`);
		});

		// Handled events
		this.wwebjs.on("qr", this.handleQr.bind(this));
		this.wwebjs.on("authenticated", this.handleAuth.bind(this));
		this.wwebjs.on("ready", this.handleReady.bind(this));
		this.wwebjs.on("message", this.handleMessage.bind(this));
		this.wwebjs.on("message_edit", this.handleMessageEdit.bind(this));
		this.wwebjs.on("message_ack", this.handleMessageAck.bind(this));
		this.wwebjs.on("message_reaction", this.handleMessageReaction.bind(this));
		this.wwebjs.on("message_revoke_everyone", this.handleMessageRevoked.bind(this));
		this.wwebjs.on("group_join", this.handleGroupJoin.bind(this));
	}

	private log(type: "info" | "error" | "debug", message: string, err?: Error) {
		switch (type) {
			case "info":
				Logger.info(`[${this.instance}:${this.id}] ${message}`);
				break;
			case "error":
				Logger.error(`[${this.instance}:${this.id}] ${message} - ${sanitizeErrorMessage(err)}`);
				break;
			case "debug":
				Logger.debug(`[${this.instance}:${this.id}] ${message}`);
				break;
		}
	}

	private async handleQr(qr: string) {
		try {
			this.log("info", "QR Generated!");
			const client = await prismaService.wppClient.findUnique({
				where: {
					id: this.id
				},
				include: {
					sectors: true
				}
			});

			if (client) {
				prismaService.wppClient.update({
					data: {
						phone: null
					},
					where: {
						id: this.id
					}
				});
				client.sectors.forEach((sector) => {
					const room: SocketServerAdminRoom = `${this.instance}:${sector.id}:admin`;

					socketService.emit(SocketEventType.WwebjsQr, room, {
						qr,
						phone: this.name
					});
				});
			}
		} catch (err) {
			this.log("error", "Error handling QR code: " + sanitizeErrorMessage(err));
		}
	}

	private async handleAuth() {
		this.log("info", `[${this.instance}:${this.id}] Authenticated!`);

		const client = await prismaService.wppClient.findUnique({
			where: {
				id: this.id
			},
			include: {
				sectors: true
			}
		});

		if (client) {
			client.sectors.forEach((sector) => {
				const room: SocketServerAdminRoom = `${this.instance}:${sector.id}:admin`;

				socketService.emit(SocketEventType.WwebjsAuth, room, {
					phone: this.name,
					success: true
				});
			});
		}
	}

	private async handleReady() {
		this.log("info", `[${this.instance} - ${this.name}] Ready!`);
		this.isReady = true;

		await prismaService.wppClient.update({
			where: {
				id: this.id
			},
			data: {
				phone: this.wwebjs.info.wid.user
			}
		});

		if (this.instance === "nunes") {
			runFixLidMessagesRoutine(this.instance, this.wwebjs);
		}
	}

	private async handleMessage(msg: WAWebJS.Message) {
		this.log("info", "Message received: " + msg.id._serialized);
		const process = new ProcessingLogger(this.instance, "wwebjs-message-receive", msg.id._serialized, msg);

		try {
			const chat = await msg.getChat();

			if (msg.fromMe) {
				return process.log("Message ignored: it is from me.");
			}

			if (msg.isStatus) {
				return process.log("Message ignored: it is status.");
			}

			if (IGNORED_MESSAGE_TYPES.includes(msg.type)) {
				return process.log("Message ignored: it is ignored type.");
			}

			if (msg.from === "status@broadcast") {
				return process.log("Message ignored: it is broadcast.");
			}

			const parsedMsg = await MessageParser.parse(
				this.id,
				process,
				this.instance,
				msg,
				false,
				false,
				chat.isGroup
			);
			process.log(`Message is successfully parsed!`, parsedMsg);

			if (!chat.isGroup) {
				const savedMsg = await messagesService.insertMessage(parsedMsg);
				process.log(`Message is successfully saved!`);
				const contact = await msg.getContact();
				const contactName = contact?.name || contact?.verifiedName || contact?.pushname || null;
				process.log(`Message sent to distribution service!`);
				await messagesDistributionService.processMessage(this.instance, this.id, savedMsg, contactName);
				process.success(savedMsg);
			}
			if (chat.isGroup) {
				const contact = await msg.getContact();
				await internalChatsService.receiveMessage(
					chat.id.user,
					parsedMsg,
					contact?.number || contact?.pushname || msg.from.split("@")[0]!
				);
			}
		} catch (err) {
			process.log(`Error while processing message: ${sanitizeErrorMessage(err)}`);
			process.failed(err);
		}
	}

	private async handleMessageEdit(message: WAWebJS.Message) {
		this.log("info", "Message edited! " + message.id._serialized);
		const process = new ProcessingLogger(this.instance, "wwebjs-message-edit", message.id._serialized, message);
		try {
			const chat = await message.getChat();

			process.log("Chat info:", { id: chat.id._serialized, isGroup: chat.isGroup });
			if (message && chat) {
				if (chat.isGroup) {
					process.log("Message is in a group chat. Processing message edit...");
					await internalChatsService.receiveMessageEdit(chat.id.user, message.id.id, message.body);
					return;
				} else {
					process.log("Message is in a private chat. Processing message edit...");
					await messagesDistributionService.processMessageEdit(
						"wwebjs",
						message.id._serialized,
						message.body
					);
				}
			}
		} catch (err: any) {
			process.failed(err);
		}
	}

	private handleMessageAck({ id }: WAWebJS.Message, ack: WAWebJS.MessageAck) {
		this.log("info", "Message ack: " + ack + " | " + id._serialized + "!");
		if (typeof ack === "number") {
			const status = MessageParser.getMessageStatus(ack);
			messagesDistributionService.processMessageStatus("wwebjs", id._serialized, status);
		}
	}

	private handleMessageReaction(_reaction: WAWebJS.Reaction) {}

	private handleMessageRevoked({ id }: WAWebJS.Message) {
		this.log("info", "Message revoked! " + id._serialized);
	}

	private async handleGroupJoin(notification: WAWebJS.GroupNotification) {
		const contact = await notification.getContact();
		console.log(contact);
		await internalChatsService.addParticipantToInternalChat(notification.chatId, `external:${contact.id.user}`);
	}

	public async getProfilePictureUrl(phone: string) {
		return await this.wwebjs
			.getProfilePicUrl(phone + "@c.us")
			.then((url) => url)
			.catch(() => null);
	}

	public async isValidWhatsapp(phone: string) {
		return await this.wwebjs.isRegisteredUser(phone + "@c.us");
	}

	public async getValidWhatsapp(phone: string) {
		const result = await this.wwebjs.getNumberId(phone);

		return result ? result.user : null;
	}

	public async sendMessage(options: SendMessageOptions, isGroup: boolean = false) {
		const id = randomUUID();
		const process = new ProcessingLogger(this.instance, "wwebjs-send-message", id, options);

		process.log("Iniciando envio de mensagem.", options);

		const to = `${options.to}${isGroup ? "@g.us" : "@c.us"}`;

		console.log("to:", to);
		const params: WAWebJS.MessageSendOptions = {};

		if (options.quotedId) {
			params.quotedMessageId = options.quotedId;
		}

		let mentionsText = "";
		if (options.mentions?.length) {
			const mentionIds = options.mentions
				.map((user) => {
					const phone = user.phone?.replace(/\D/g, "");
					if (!phone) {
						process.log("Telefone inválido em menção:", user);
						return null;
					}
					return `${phone}@c.us`;
				})
				.filter((id): id is string => id !== null);

			mentionsText = options.mentions.map((user) => `@${user.name || user.phone}`).join(" ");

			params.mentions = mentionIds;
		}

		let content: string | WAWebJS.MessageMedia;

		if ("fileUrl" in options) {
			process.log("Preparando mídia via fileUrl:", options.fileUrl);

			if (options.sendAsAudio) {
				params.sendAudioAsVoice = true;
			}
			if (options.sendAsDocument /* || options.fileType?.includes("video") */) {
				params.sendMediaAsDocument = true;
			}
			if (!options.sendAsAudio) {
				const texto = options.text?.trim() ?? "";

				//const usarMentionsText = !!mentionsText && /@\s*$/.test(texto);

				params.caption = options.mentions?.length ? texto.replace(/@\s*$/, mentionsText) : texto;
			}

			try {
				content = await WAWebJS.MessageMedia.fromUrl(options.fileUrl, {
					unsafeMime: true,
					filename: options.fileName
				});
			} catch (err) {
				process.log("Erro ao carregar mídia:", err);
				throw err;
			}
		} else {
			const texto = options.text?.trim() ?? "";
			//const usarMentionsText = !!mentionsText && /@\s*$/.test(texto);

			content = options.mentions?.length ? texto.replace(/@\s*$/, mentionsText) : texto;
		}

		process.log("Conteúdo final:", { content, params });

		try {
			const sentMsg = await this.wwebjs.sendMessage(to, content, params);
			process.log("Mensagem enviada com sucesso.", sentMsg);

			const parsedMsg = await MessageParser.parse(this.id, process, this.instance, sentMsg, true, true);

			process.success(parsedMsg);
			return parsedMsg;
		} catch (err) {
			process.log("Erro ao enviar mensagem.", err);
			process.failed(err);
			throw err;
		}
	}

	public async editMessage(options: EditMessageOptions) {
		const process = new ProcessingLogger(
			this.instance,
			"wwebjs-edit-message",
			String(options.messageId + "_" + Date.now()),
			options
		);

		try {
			process.log("Buscando mensagem pelo ID...", options.messageId);
			const wwebjsMsg = await this.wwebjs.getMessageById(options.messageId);

			if (!wwebjsMsg) {
				process.log("Mensagem não encontrada.");
				throw new Error("Message not found");
			}

			process.log("Gerando texto e menções...");
			const { text, mentions } = await this.getTextWithMentions(options.text, options.mentions || []);
			process.log("Texto gerado:", text);
			process.log("IDs das menções:", mentions);
			process.log("Editando mensagem...");
			const editedMsg = await wwebjsMsg.edit(text, { mentions });

			if (!editedMsg) {
				process.log("Falha ao editar mensagem.");
				throw new Error("Message not edited");
			}

			process.log("Mensagem editada com sucesso.");
		} catch (err) {
			process.log("Erro ao editar mensagem: " + sanitizeErrorMessage(err));
			process.failed(err);
			throw err;
		}
	}

	public async getGroups() {
		const chats = await this.wwebjs.getChats();

		return chats.filter((c) => c.isGroup);
	}

	public async forwardMessage(to: string, messageId: string, isGroup: boolean = false) {
		const process = new ProcessingLogger(this.instance, "wwebjs-forward-message", messageId, {
			to,
			messageId,
			isGroup
		});

		try {
			process.log("Buscando mensagem original...");
			const message = await this.wwebjs.getMessageById(messageId);

			if (!message) {
				process.failed("Mensagem original não encontrada.");
				throw new Error("Mensagem original não encontrada.");
			}

			const chatId = `${to}${isGroup ? "@g.us" : "@c.us"}`;
			process.log(`Encaminhando mensagem para ${chatId}`);
			await message.forward(chatId);

			process.success("Mensagem encaminhada com sucesso.");
		} catch (err) {
			process.failed("Erro ao encaminhar mensagem.");
			throw err;
		}
	}

	/**
	 * Retorna o texto com as menções inseridas e o array de mentions para WAWebJS.MessageSendOptions
	 */
	public async getTextWithMentions(text: string, mentions?: Mentions): Promise<{ text: string; mentions: string[] }> {
		if (!mentions?.length) {
			return { text, mentions: [] };
		}
		const mentionIds = mentions
			.map((user) => {
				const phone = user.phone?.replace(/\D/g, "");
				if (!phone) {
					return null;
				}
				return `${phone}@c.us`;
			})
			.filter((id): id is string => id !== null);

		const mentionsText = mentions.map((user) => `@${user.name || user.phone}`).join(" ");

		let newText: string;
		if (/@\s*$/.test(text)) {
			newText = text.replace(/@\s*$/, mentionsText);
		} else {
			newText = `${text} ${mentionsText}`;
		}

		return { text: newText, mentions: mentionIds };
	}

	public async getTemplates(): Promise<any> {
		throw new Error("Not supported by WWEBJS");
	}

	public async sendTemplate(
		_options: SendTemplateOptions,
		_chatId: number,
		_contactId: number
	): Promise<CreateMessageDto> {
		throw new Error("Not supported by WWEBJS");
	}
}

export default WWEBJSWhatsappClient;
