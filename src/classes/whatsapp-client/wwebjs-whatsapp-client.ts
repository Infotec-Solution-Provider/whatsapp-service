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
	private clientId: string;

	constructor(
		private readonly wppInstanceId: number,
		public readonly instance: string,
		public readonly phone: string
	) {
		const clientId = `${instance}_${phone}`;
		this.clientId = clientId;

		this.client = new Client({
			authStrategy: new LocalAuth({ clientId }),
			puppeteer: {
				...PUPPETEER_ARGS,
				browserURL: process.env["WPP_BROWSER_PATH"]!
			}
		});

		// Log events
		this.buildEvents(clientId);

		this.client
			.initialize()
			.then(() => {
				Logger.info(`[${clientId}] Client initialized!`);
			})
			.catch((err) => {
				Logger.error(
					`Error initializing client: ${sanitizeErrorMessage(err)}`
				);
				console.log("Error class name", err.constructor.name);
			});
	}

	private buildEvents(clientId: string) {
		this.client.on("change_state", (s) => {
			Logger.info(`[${clientId}] State changed: ${s}`);
		});
		this.client.on("disconnected", (r) => {
			Logger.info(`[${clientId}] Disconnected: ${r}`);
		});
		this.client.on("auth_failure", (m) => {
			Logger.info(`[${clientId}] Auth failure: ${m}`);
		});
		this.client.on("ready", () => {
			Logger.info(`[${clientId}] Ready!`);
		});

		this.client.on("loading_screen", (p, m) => {
			Logger.info(`[${clientId}] Loading: ${p}% | ${m}`);
		});

		// Handled events
		this.client.on("qr", (qr) => this.handleQr(qr));
		this.client.on("authenticated", () => this.handleAuth());

		this.client.on("message_create", (message) =>
			this.handleMessage(message)
		);
		this.client.on("message_edit", (message) =>
			this.handleMessageEdit(message)
		);
		this.client.on("message_ack", (message, ack) =>
			this.handleMessageAck(message, ack)
		);
		this.client.on("message_reaction", (reaction) =>
			this.handleMessageReaction(reaction)
		);
		this.client.on("message_revoke_everyone", (message) =>
			this.handleMessageRevokedEveryone(message)
		);
	}

	private handleQr(qr: string) {
		Logger.debug(`QR generated for ${this.clientId}`);
		const room: SocketServerAdminRoom = `${this.instance}:${1}:admin`;

		socketService.emit(SocketEventType.WwebjsQr, room, {
			qr,
			phone: this.phone
		});
	}

	private handleAuth() {
		Logger.debug(`Authenticated for ${this.clientId}`);
		const room: SocketServerAdminRoom = `${this.instance}:${1}:admin`;

		socketService.emit(SocketEventType.WwebjsAuth, room, {
			phone: this.phone,
			success: true
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
				this.wppInstanceId,
				savedMsg,
				msg.author
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

	private handleMessageRevokedEveryone({ id }: WAWebJS.Message) {
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
