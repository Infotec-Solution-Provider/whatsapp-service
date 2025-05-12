import "dotenv/config";
import WAWebJS, { Client, LocalAuth } from "whatsapp-web.js";
import WhatsappClient from "./whatsapp-client";
import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { randomUUID } from "node:crypto";
import { SocketEventType, SocketServerAdminRoom } from "@in.pulse-crm/sdk";
import MessageParser from "../parsers/wwebjs-message.parser";
import prismaService from "../services/prisma.service";
import socketService from "../services/socket.service";
import ProcessingLogger from "../utils/processing-logger";
import messagesService from "../services/messages.service";
import messagesDistributionService from "../services/messages-distribution.service";
import { SendMessageOptions } from "../types/whatsapp-instance.types";
import internalChatsService from "../services/internal-chats.service";

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

const IGNORED_MESSAGE_TYPES =
	process.env["WWEBJS_IGNORED_MESSAGE_TYPES"]?.split(",") || [];

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
				browserURL: process.env["WWEBJS_BROWSER_PATH"]!
			}
		});

		// Log events
		this.buildEvents(instance, id);

		this.wwebjs.initialize().catch((err) => {
			Logger.error(
				`Error initializing client: ${sanitizeErrorMessage(err)}`
			);
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
		this.wwebjs.on("message_create", this.handleMessage.bind(this));
		this.wwebjs.on("message_edit", this.handleMessageEdit.bind(this));
		this.wwebjs.on("message_ack", this.handleMessageAck.bind(this));
		this.wwebjs.on(
			"message_reaction",
			this.handleMessageReaction.bind(this)
		);
		this.wwebjs.on(
			"message_revoke_everyone",
			this.handleMessageRevoked.bind(this)
		);
	}

	private async handleQr(qr: string) {
		try {
			Logger.info(`[${this.instance}:${this.id}] QR Generated!`);
			const client = await prismaService.wppClient.findUnique({
				where: {
					id: this.id
				},
				include: {
					WppSector: true
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
				client.WppSector.forEach((sector) => {
					const room: SocketServerAdminRoom = `${this.instance}:${sector.id}:admin`;

					socketService.emit(SocketEventType.WwebjsQr, room, {
						qr,
						phone: this.name
					});
				});
			}
		} catch (err) {
			Logger.error(
				"Error handling QR code: " + sanitizeErrorMessage(err)
			);
		}
	}

	private async handleAuth() {
		Logger.info(`[${this.instance}:${this.id}] Authenticated!`);

		const client = await prismaService.wppClient.findUnique({
			where: {
				id: this.id
			},
			include: {
				WppSector: true
			}
		});

		if (client) {
			client.WppSector.forEach((sector) => {
				const room: SocketServerAdminRoom = `${this.instance}:${sector.id}:admin`;

				socketService.emit(SocketEventType.WwebjsAuth, room, {
					phone: this.name,
					success: true
				});
			});
		}
	}

	private async handleReady() {
		Logger.info(`[${this.instance} - ${this.name}] Ready!`);
		this.isReady = true;

		await prismaService.wppClient.update({
			where: {
				id: this.id
			},
			data: {
				phone: this.wwebjs.info.wid.user
			}
		});
	}

	private async handleMessage(msg: WAWebJS.Message) {
		Logger.debug("Message received: " + msg.id._serialized);
		const process = new ProcessingLogger(
			this.instance,
			"wwebjs-message-receive",
			msg.id._serialized,
			msg
		);

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
				process,
				this.instance,
				msg
			);
			process.log(`Message is successfully parsed!`, parsedMsg);

			if (!chat.isGroup) {
				const savedMsg = await messagesService.insertMessage(parsedMsg);
				process.log(`Message is successfully saved!`);
				messagesDistributionService.processMessage(
					this.instance,
					this.id,
					savedMsg
				);
				process.log(`Message sent to distribution service!`);
				process.success(savedMsg);
			}
			if (chat.isGroup) {
				console.log("Group message received!", chat.id);
				internalChatsService.receiveMessage(
					chat.id.user,
					parsedMsg,
					msg.author || msg.from.split("@")[0]!
				);
			}
		} catch (err) {
			process.log(
				`Error while processing message: ${sanitizeErrorMessage(err)}`
			);
			process.failed(err);
		}
	}

	private handleMessageEdit(message: WAWebJS.Message) {
		Logger.debug("Message edit: " + message.id._serialized);
	}

	private handleMessageAck({ id }: WAWebJS.Message, ack: WAWebJS.MessageAck) {
		Logger.info("Message ack: " + ack + " | " + id._serialized + "!");
		const status = MessageParser.getMessageStatus(ack);

		messagesDistributionService.processMessageStatus(
			"wwebjs",
			id._serialized,
			status
		);
	}

	private handleMessageReaction(_reaction: WAWebJS.Reaction) {}

	private handleMessageRevoked({ id }: WAWebJS.Message) {
		Logger.info("Message revoked! " + id._serialized);
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

	public async sendMessage(options: SendMessageOptions) {
		const id = randomUUID();
		const process = new ProcessingLogger(
			this.instance,
			"wwebjs-send-message",
			id,
			options
		);

		process.log("Iniciando envio de mensagem.", options);

		options.to = `${options.to}@c.us`;

		const { to, quotedId, text } = options;
		let content: string | WAWebJS.MessageMedia | null = null;
		const params: WAWebJS.MessageSendOptions = {};

		quotedId && (params.quotedMessageId = quotedId);

		if ("fileUrl" in options) {
			process.log("Preparando conteúdo da mensagem como mídia.");

			options.sendAsAudio && (params.sendAudioAsVoice = true);
			options.sendAsDocument && (params.sendMediaAsDocument = true);

			text && (params.caption = text);
			content = await WAWebJS.MessageMedia.fromUrl(options.fileUrl, {
				unsafeMime: true,
				filename: options.fileName
			});
		} else {
			process.log("Preparando conteúdo da mensagem como texto.");
			content = text!;
		}

		process.log("Conteúdo da mensagem pronto!");

		try {
			process.log("Enviando mensagem.", options);
			const sentMsg = await this.wwebjs.sendMessage(to, content, params);
			process.log("Mensagem enviada com sucesso.", sentMsg);

			const parsedMsg = await MessageParser.parse(
				process,
				this.instance,
				sentMsg,
				true,
				true
			);

			process.success(parsedMsg);
			return parsedMsg;
		} catch (err) {
			process.log("Erro ao enviar mensagem.", err);
			process.failed(err);
			throw err;
		}
	}

	public async getGroups() {
		const chats = await this.wwebjs.getChats();

		return chats.filter((c) => c.isGroup);
	}
}

export default WWEBJSWhatsappClient;
