import { WppInstanceType } from "@prisma/client";
import WABAWhatsappClient from "../classes/whatsapp-client/waba-whatsapp-client";
import WhatsappClient from "../classes/whatsapp-client/whatsapp-client";
import WWEBJSWhatsappClient from "../classes/whatsapp-client/wwebjs-whatsapp-client";
import prismaService from "./prisma.service";

class WhatsappService {
	private readonly instances = new Map<string, WhatsappClient>();

	constructor() {
		this.buildInstances().then((arr) => {
			arr.forEach((i) => {
				this.instances.set(this.toHashed(i.instance, i.phone), i);
			});
		});
	}

	public async buildInstances() {
		const instances = await prismaService.wppInstance.findMany();
		const builtInstances: WhatsappClient[] = [];

		for (const instance of instances) {
			const { type, instanceName, phone } = instance;

			switch (type) {
				case WppInstanceType.WWEBJS:
					builtInstances.push(
						new WWEBJSWhatsappClient(instanceName, phone)
					);
					break;
				case WppInstanceType.WABA:
					builtInstances.push(
						new WABAWhatsappClient(instanceName, phone)
					);
					break;
			}
		}

		return builtInstances;
	}

	private toHashed(instanceName: string, phone: string) {
		return `${instanceName}_${phone}`;
	}

	public getInstance(instanceName: string, phone: string) {
		return this.instances.get(this.toHashed(instanceName, phone));
	}
}

export default new WhatsappService();
