import "dotenv/config";
import WAWebJS, { Client, LocalAuth } from "whatsapp-web.js";
import WhatsappClient from "./whatsapp-client";
import { SendMessageOptions } from "../../types/whatsapp-instance.types";
import { Logger } from "@in.pulse-crm/utils";
import socketService from "../../services/socket.service";
import { SocketEventType, SocketServerAdminRoom } from "@in.pulse-crm/sdk";
import WWEBJSMessageAdapter from "../adapters/wwebjs-message.adapter";

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

class WWEBJSWhatsappClient implements WhatsappClient {
	private client: Client;

	constructor(
		public readonly instance: string,
		public readonly phone: string
	) {
		const clientId = `${instance}_${phone}`;

		this.client = new Client({
			authStrategy: new LocalAuth({ clientId }),
			puppeteer: {
				...PUPPETEER_ARGS,
				browserURL: process.env["WPP_BROWSER_PATH"]!,
			},
		});

		// Log events
		this.buildEvents(clientId);
		this.client.initialize();
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
		Logger.debug(`QR generated for ${this.instance}:${this.phone}`);
		const room: SocketServerAdminRoom = `${this.instance}:${1}:admin`;

		socketService.emit(SocketEventType.WwebjsQr, room, { qr, phone: this.phone });
	}

	private handleAuth() {
		Logger.debug(`Authenticated for ${this.instance}:${this.phone}`);
		const room: SocketServerAdminRoom = `${this.instance}:${1}:admin`;

		socketService.emit(SocketEventType.WwebjsAuth, room, { phone: this.phone, success: true });
	}

	private async handleMessage(message: WAWebJS.Message) {
		const parsedMessage = await WWEBJSMessageAdapter.parse(this.instance, message);

		Logger.debug("Message received:", parsedMessage);

	}

	private handleMessageEdit(message: WAWebJS.Message) {
		Logger.debug("Message edit: " + message.id._serialized);
	}

	private handleMessageAck({ id }: WAWebJS.Message, ack: WAWebJS.MessageAck) {
		Logger.info("Message ack: " + ack + " | " + id._serialized + "!");
	}

	private handleMessageReaction(_reaction: WAWebJS.Reaction) { }

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

	public async sendMessage({ }: SendMessageOptions) {
		throw new Error("Method not implemented.");
	}
}

export default WWEBJSWhatsappClient;
