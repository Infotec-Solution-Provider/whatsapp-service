import prismaService from "./prisma.service";
import { WppInstanceType } from "@prisma/client";
import WebWhatsappClient from "../entities/whatsapp-client/web-whatsapp-client";
import MetaWhatsappClient from "../entities/whatsapp-client/meta-whatsapp-client";
import WhatsappClient from "../entities/whatsapp-client/whatsapp-client";

class WhatsappService {
	private readonly instances = new Map<string, WhatsappClient>();

	constructor() {
		this.buildInstances().then((arr) => {
			arr.forEach((i) => {
				this.instances.set(this.toHashed(i.instanceName, i.phone), i);
			});
		});
	}

	private async buildInstances() {
		const instances = await prismaService.wppInstance.findMany();
		const builtInstances: WhatsappClient[] = [];

		for (const instance of instances) {
			const { type, instanceName, phone } = instance;

			switch (type) {
				case WppInstanceType.WWEBJS:
					builtInstances.push(
						new WebWhatsappClient({ instanceName, phone })
					);
					break;
				case WppInstanceType.WABA:
					builtInstances.push(
						new MetaWhatsappClient({ instanceName, phone })
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
