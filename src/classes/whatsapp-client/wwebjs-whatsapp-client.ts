import WAWebJS, { Client, LocalAuth } from "whatsapp-web.js";
import WhatsappClient from "./whatsapp-client";
import { SendMessageOptions, WhatsappInstanceProps } from "../../types/whatsapp-instance.types";
import { Logger } from "@in.pulse-crm/utils";

const PUPPETEER_ARGS = {
	headless: true,
	executablePath: process.env["WPP_BROWSER_PATH"]!,
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
	public readonly phone: string;
	public readonly instanceName: string;
	private client: Client;

	constructor({ phone, instanceName }: WhatsappInstanceProps) {
		const clientId = `${instanceName}_${phone}`;

		this.client = new Client({
			authStrategy: new LocalAuth({ clientId }),
			puppeteer: { ...PUPPETEER_ARGS }
		});

		this.phone = phone;
		this.instanceName = instanceName;

		// Log events
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
		this.client.on("authenticated", () => {
			Logger.info(`[${clientId}] Authenticated!`);
		});
		this.client.on("loading_screen", (p, m) => {
			Logger.info(`[${clientId}] Loading: ${p}% | ${m}`);
		});

		// Handled events
		this.client.on("qr", this.handleQr);
		this.client.on("message_create", this.handleMessage);
		this.client.on("message_edit", this.handleMessageEdit);
		this.client.on("message_ack", this.handleMessageAck);
		this.client.on("message_reaction", this.handleMessageReaction);
		this.client.on(
			"message_revoke_everyone",
			this.handleMessageRevokedEveryone
		);
	}

	private handleQr(qr: string) {
		Logger.debug(`QR generated for ${this.instanceName}:${this.phone}`, qr);
	}

	private handleMessage(message: WAWebJS.Message) {
		Logger.debug("Message:", message.id._serialized);
	}

	private handleMessageEdit(message: WAWebJS.Message) {
		Logger.debug("Message edit:", message.id._serialized);
	}

	private handleMessageAck({ id }: WAWebJS.Message, ack: WAWebJS.MessageAck) {
		Logger.debug("Message ack:", { id, ack });
	}

	private handleMessageReaction(reaction: WAWebJS.Reaction) {
		Logger.debug("Message reaction:", reaction);
	}

	private handleMessageRevokedEveryone({ id }: WAWebJS.Message) {
		Logger.debug("Message revoked:", id);
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
