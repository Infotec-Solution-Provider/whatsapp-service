import "dotenv/config";
import WAWebJS, { Client, LocalAuth } from "whatsapp-web.js";
import WhatsappClient from "./whatsapp-client";
import { SendMessageOptions } from "../../types/whatsapp-instance.types";
import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import socketService from "../../services/socket.service";
import { SocketEventType, SocketServerAdminRoom } from "@in.pulse-crm/sdk";
import MessageParser from "../parsers/wwebjs-message.parser";
import messagesService from "../../services/messages.service";
import ProcessingLogger from "../processing-logger";
import messagesDistributionService from "../../services/messages-distribution.service";
import prismaService from "../../services/prisma.service";

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
	private client: Client;
	private lastQrTimestamp: number = Date.now();

	constructor(
		public readonly id: number,
		public readonly instance: string,
		public readonly name: string
	) {
		console.log(process.env["WWEBJS_BROWSER_PATH"]);
		this.client = new Client({
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

		this.client.initialize().catch((err) => {
			Logger.error(
				`Error initializing client: ${sanitizeErrorMessage(err)}`
			);
			console.log("Error class name", err.constructor.name);
		});
	}

	private buildEvents(instance: string, id: number) {
		const instanceAndId = `${instance}:${id}`;

		this.client.on("change_state", (s) => {
			Logger.info(`[${instanceAndId}] State changed: ${s}`);
		});
		this.client.on("disconnected", (r) => {
			Logger.info(`[${instanceAndId}] Disconnected: ${r}`);
		});
		this.client.on("auth_failure", (m) => {
			Logger.info(`[${instanceAndId}] Auth failure: ${m}`);
		});
		this.client.on("loading_screen", (p, m) => {
			Logger.info(`[${instanceAndId}] Loading: ${p}% | ${m}`);
		});

		// Handled events
		this.client.on("qr", this.handleQr.bind(this));
		this.client.on("authenticated", this.handleAuth.bind(this));
		this.client.on("ready", this.handleReady.bind(this));
		this.client.on("message_create", this.handleMessage.bind(this));
		this.client.on("message_edit", this.handleMessageEdit.bind(this));
		this.client.on("message_ack", this.handleMessageAck.bind(this));
		this.client.on(
			"message_reaction",
			this.handleMessageReaction.bind(this)
		);
		this.client.on(
			"message_revoke_everyone",
			this.handleMessageRevoked.bind(this)
		);
	}

	private handleQr(qr: string) {
		const now = Date.now();
		console.log(`Qr generated with delay: ${now - this.lastQrTimestamp}`);
		this.lastQrTimestamp = now;
		Logger.debug(`QR generated for ${this.instance} - ${this.name}`);
		const room: SocketServerAdminRoom = `${this.instance}:${1}:admin`;

		socketService.emit(SocketEventType.WwebjsQr, room, {
			qr,
			phone: this.name
		});
	}

	private handleAuth() {
		Logger.debug(`Authenticated for ${this.instance} - ${this.name}`);
		const room: SocketServerAdminRoom = `${this.instance}:${1}:admin`;

		socketService.emit(SocketEventType.WwebjsAuth, room, {
			phone: this.name,
			success: true
		});
	}

	private async handleReady() {
		Logger.info(`[${this.instance} - ${this.name}] Ready!`);

		await prismaService.wppClient.update({
			where: {
				id: this.id
			},
			data: {
				phone: this.client.info.wid.user
			}
		});
	}

	private async handleMessage(msg: WAWebJS.Message) {
		const process = new ProcessingLogger(
			this.instance,
			"wwebjs-message-receive",
			msg.id._serialized,
			msg
		);

		try {
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

			if (!msg.from.includes("@c.us")) {
				return process.log("Message ignored: it is not a contact.");
			}

			const parsedMsg = await MessageParser.parse(this.instance, msg);
			process.log(`Message is successfully parsed!`, parsedMsg);

			const savedMsg = await messagesService.insertMessage(parsedMsg);
			process.log(`Message is successfully saved!`);

			messagesDistributionService.processMessage(
				this.instance,
				this.id,
				savedMsg
			);
			process.log(`Message sent to distribution service!`);
			process.success(savedMsg);
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
	}

	private handleMessageReaction(_reaction: WAWebJS.Reaction) {}

	private handleMessageRevoked({ id }: WAWebJS.Message) {
		Logger.info("Message revoked! " + id._serialized);
	}

	public async getProfilePictureUrl(phone: string) {
		return await this.client
			.getProfilePicUrl(phone + "@c.us")
			.then((url) => url)
			.catch(() => null);
	}

	public async isValidWhatsapp(phone: string) {
		return await this.client.isRegisteredUser(phone + "@c.us");
	}

	public async sendMessage({}: SendMessageOptions) {
		throw new Error("Method not implemented.");
	}
}

export default WWEBJSWhatsappClient;
