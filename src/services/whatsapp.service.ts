import { WppClientType } from "@prisma/client";
import WABAWhatsappClient from "../classes/whatsapp-client/waba-whatsapp-client";
import WhatsappClient from "../classes/whatsapp-client/whatsapp-client";
import WWEBJSWhatsappClient from "../classes/whatsapp-client/wwebjs-whatsapp-client";
import prismaService from "./prisma.service";

class WhatsappService {
	private readonly clients = new Map<number, WhatsappClient>();

	public async buildClients() {
		const clients = await prismaService.wppClient.findMany();

		for (const client of clients) {
			switch (client.type) {
				case WppClientType.WWEBJS:
					console.log("WWEBJS creating");
					const WWEBJSClient = new WWEBJSWhatsappClient(
						client.id,
						client.instance,
						client.name
					);
					this.clients.set(client.id, WWEBJSClient);
					break;
				case WppClientType.WABA:
					const WABAClient = new WABAWhatsappClient(
						client.instance,
						client.name
					);
					this.clients.set(client.id, WABAClient);
					break;
				default:
					break;
			}
		}
	}

	public getClient(id: number) {
		return this.clients.get(id);
	}
}

export default new WhatsappService();
