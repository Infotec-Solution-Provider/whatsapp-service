import WAWebJS, { Client, LocalAuth } from "whatsapp-web.js";
import PUPPETEER_ARGS from "./puppeteer-args";
import Logger from "../Logger.entity";
import { WppClientConstructorProps, WppClientSendMessageOptions } from "./types";

class WppClient {
	public readonly phone: string;
	public readonly instanceName: string;
	private client: Client;

	constructor({ phone, instanceName }: WppClientConstructorProps) {
		const clientId = `${instanceName}_${phone}`;

		this.client = new Client({
			authStrategy: new LocalAuth({ clientId }),
			puppeteer: { ...PUPPETEER_ARGS },
		});

		this.phone = phone;
		this.instanceName = instanceName;

		// Log events
		this.client.on("change_state", (s) => Logger.info(`[${clientId}] State changed: ${s}`));
		this.client.on("disconnected", (r) => Logger.info(`[${clientId}] Disconnected: ${r}`));
		this.client.on("auth_failure", (m) => Logger.info(`[${clientId}] Auth failure: ${m}`));
		this.client.on("ready", () => Logger.info(`[${clientId}] Ready!`));
		this.client.on("authenticated", () => Logger.info(`[${clientId}] Authenticated!`));
		this.client.on("loading_screen", (p, m) => Logger.info(`[${clientId}] Loading: ${p}% | ${m}`));

		// Handled events
		this.client.on("qr", this.handleQrCode);
		this.client.on("message_create", this.handleMessage);
		this.client.on("message_edit", this.handleMessageEdit);
		this.client.on("message_ack", this.handleMessageStatus);
		this.client.on("message_reaction", this.handleMessageReaction);
		this.client.on("message_revoke_everyone", this.handleMessageRevoked);
	}

	private handleQrCode(qrCode: string) {
		console.log("QR Code:", qrCode);
	}

	private handleMessage(message: WAWebJS.Message) {
		console.log("Message:", message.id._serialized);
	}

	private handleMessageEdit(message: WAWebJS.Message) {
		console.log("Message edit:", message.id._serialized);
	}

	private handleMessageStatus(message: WAWebJS.Message, ack: WAWebJS.MessageAck) {
		console.log("Message ack:", message.id._serialized, ack);
	}

	private handleMessageReaction(oldMessage: WAWebJS.Message, newMessage: WAWebJS.Message) {
		console.log("Message revoked:", oldMessage.id._serialized, newMessage.id._serialized);
	}

	private handleMessageRevoked(message: WAWebJS.Message) {
		console.log("Message revoked:", message.id._serialized);
	}

	public async getProfilePictureUrl(phone: string) {
		return await this.client
			.getProfilePicUrl(phone + "@c.us")
			.then((url) => url)
			.catch(() => null);
	}

	public async isPhoneValid(phone: string) {
		return await this.client.isRegisteredUser(phone + "@c.us");
	}

	public async sendMessage({}: WppClientSendMessageOptions) {
		throw new Error("Method not implemented.");
	}
}

export default WppClient;
