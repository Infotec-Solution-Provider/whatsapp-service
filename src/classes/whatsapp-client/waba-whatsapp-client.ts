import { SendMessageOptions, WhatsappInstanceProps } from "../../types/whatsapp-instance.types";
import WhatsappClient from "./whatsapp-client";

class WABAWhatsappClient implements WhatsappClient {
	public readonly phone: string;
	public readonly instanceName: string;

	constructor({ phone, instanceName }: WhatsappInstanceProps) {
		this.phone = phone;
		this.instanceName = instanceName;
	}

	public async getProfilePictureUrl(_: string): Promise<string | null> {
		throw new Error("Method not implemented.");
	}

	public async isValidWhatsapp(_: string): Promise<boolean> {
		throw new Error("Method not implemented.");
	}

	public async sendMessage({}: SendMessageOptions): Promise<void> {
		throw new Error("Method not implemented.");
	}
}

export default WABAWhatsappClient;
