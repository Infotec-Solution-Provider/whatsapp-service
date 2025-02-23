import prismaService from "./prisma.service";
import { WppInstanceType } from "@prisma/client";
import WwebjsInstance from "../entities/wwebjs-instance";
import WabaInstance from "../entities/waba-instance";
import WhatsappInstance from "../entities/whatsapp-instance";

class WhatsappService {
	private readonly instances = new Map<string, WhatsappInstance>();

	constructor() {
		this.buildInstances().then((arr) => {
			arr.forEach((i) => {
				this.instances.set(this.toHashed(i.instanceName, i.phone), i);
			});
		});
	}

	private async buildInstances() {
		const instances = await prismaService.wppInstance.findMany();
		const builtInstances: WhatsappInstance[] = [];

		for (const instance of instances) {
			const { type, instanceName, phone } = instance;

			switch (type) {
				case WppInstanceType.WWEBJS:
					builtInstances.push(new WwebjsInstance({ instanceName, phone }));
					break;
				case WppInstanceType.WABA:
					builtInstances.push(new WabaInstance({ instanceName, phone }));
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
