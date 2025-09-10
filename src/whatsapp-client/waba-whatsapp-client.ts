import CreateMessageDto from "../dtos/create-message.dto";
import { EditMessageOptions, SendMessageOptions } from "../types/whatsapp-instance.types";
import WhatsappClient from "./whatsapp-client";

class WABAWhatsappClient implements WhatsappClient {
	constructor(
		public readonly instance: string,
		public readonly name: string,
		public readonly phone: string
	) {}

	public async getProfilePictureUrl(_: string): Promise<string | null> {
		throw new Error("Method not implemented.");
	}

	public async isValidWhatsapp(_: string): Promise<boolean> {
		throw new Error("Method not implemented.");
	}

	public async sendMessage({}: SendMessageOptions): Promise<CreateMessageDto> {
		throw new Error("Method not implemented.");
	}

	public async editMessage({}: EditMessageOptions): Promise<CreateMessageDto> {
		throw new Error("Method not implemented.");
	}
}

export default WABAWhatsappClient;
