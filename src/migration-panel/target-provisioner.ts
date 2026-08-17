import { Prisma, WppClientType } from "@prisma/client";
import prismaService from "../services/prisma.service";
import InstancesApiClient from "./instances-api";
import { MigrationInstanceConfig } from "./types";

export interface ProvisionedClient {
	id: number;
	name: string;
	instance: string;
	isActive: boolean;
}

class TargetProvisioner {
	public async inspect(config: MigrationInstanceConfig): Promise<{ client: ProvisionedClient | null; dataCounts: Record<string, number> }> {
		const client = await prismaService.wppClient.findFirst({
			where: { OR: [{ name: config.clientName }, { instance: config.targetInstance }] },
			select: { id: true, name: true, instance: true, isActive: true },
		});
		const [contacts, chats, messages, sectors, readyMessages] = await Promise.all([
			prismaService.wppContact.count({ where: { instance: config.targetInstance } }),
			prismaService.wppChat.count({ where: { instance: config.targetInstance } }),
			prismaService.wppMessage.count({ where: { instance: config.targetInstance } }),
			prismaService.wppSector.count({ where: { instance: config.targetInstance } }),
			prismaService.readyMessage.count({ where: { instance: config.targetInstance } }),
		]);
		return {
			client,
			dataCounts: { contacts, chats, messages, sectors, readyMessages },
		};
	}

	public async ensure(config: MigrationInstanceConfig): Promise<ProvisionedClient> {
		const current = await prismaService.wppClient.findFirst({
			where: { OR: [{ name: config.clientName }, { instance: config.targetInstance }] },
		});
		if (current && (current.name !== config.clientName || current.instance !== config.targetInstance)) {
			throw new Error("Já existe um cliente WhatsApp com o mesmo nome ou instância, mas com outra combinação");
		}
		if (current?.isActive) {
			throw new Error("O cliente alvo já está ativo; faça o cutover somente pelo painel após validar a carga");
		}

		if (current && !config.options.allowExistingTargetData) {
			const inspection = await this.inspect(config);
			const dataTotal = Object.values(inspection.dataCounts).reduce((sum, count) => sum + count, 0);
			if (dataTotal > 0) {
				throw new Error("O alvo já possui dados; marque allowExistingTargetData somente depois de confirmar o escopo");
			}
		}

		const instancesApi = new InstancesApiClient(config.instancesApi);
		await instancesApi.ensureInstance(config.targetInstance, config.source, config.instanceParameters);

		const clientData = this.clientData(config);
		const client = current
			? await prismaService.wppClient.update({ where: { id: current.id }, data: clientData })
			: await prismaService.wppClient.create({ data: clientData });

		if (config.options.importParameters) {
			await this.ensureParameters(config);
		}
		return { id: client.id, name: client.name, instance: client.instance, isActive: client.isActive };
	}

	public async activate(config: MigrationInstanceConfig): Promise<ProvisionedClient> {
		const client = await prismaService.wppClient.findFirst({
			where: { name: config.clientName, instance: config.targetInstance },
		});
		if (!client) {
			throw new Error("Cliente alvo não foi provisionado");
		}
		const active = await prismaService.wppClient.update({
			where: { id: client.id },
			data: { isActive: true },
		});
		return { id: active.id, name: active.name, instance: active.instance, isActive: active.isActive };
	}

	public async deactivate(config: MigrationInstanceConfig): Promise<void> {
		const client = await prismaService.wppClient.findFirst({
			where: { name: config.clientName, instance: config.targetInstance },
			select: { id: true },
		});
		if (client) {
			await prismaService.wppClient.update({ where: { id: client.id }, data: { isActive: false } });
		}
	}

	public async targetCounts(instance: string): Promise<Record<string, number>> {
		const [contacts, chats, messages, sectors, readyMessages] = await Promise.all([
			prismaService.wppContact.count({ where: { instance } }),
			prismaService.wppChat.count({ where: { instance } }),
			prismaService.wppMessage.count({ where: { instance } }),
			prismaService.wppSector.count({ where: { instance } }),
			prismaService.readyMessage.count({ where: { instance } }),
		]);
		return { contacts, chats, messages, sectors, readyMessages };
	}

	private clientData(config: MigrationInstanceConfig): Prisma.WppClientUncheckedCreateInput {
		const data: Prisma.WppClientUncheckedCreateInput = {
			name: config.clientName,
			instance: config.targetInstance,
			type: config.provider as WppClientType,
			isActive: false,
		};
		if (config.phone) data.phone = config.phone;
		if (config.remoteClientUrl) data.remoteClientUrl = config.remoteClientUrl;
		if (config.wabaPhoneId) data.WABAPhoneId = config.wabaPhoneId;
		if (config.wabaAccountId) data.WABAAccountId = config.wabaAccountId;
		if (config.wabaToken) data.WABAToken = config.wabaToken;
		if (config.gupshupToken) data.gupshupToken = config.gupshupToken;
		if (config.gupshupAppName) data.gupshupAppName = config.gupshupAppName;
		if (config.gupshupAppId) data.gupshupAppId = config.gupshupAppId;
		return data;
	}

	private async ensureParameters(config: MigrationInstanceConfig): Promise<void> {
		for (const [key, value] of Object.entries(config.instanceParameters)) {
			const existing = await prismaService.parameter.findFirst({
				where: { scope: "INSTANCE", instance: config.targetInstance, key },
			});
			if (existing) {
				await prismaService.parameter.update({ where: { id: existing.id }, data: { value } });
			} else {
				await prismaService.parameter.create({
					data: { scope: "INSTANCE", instance: config.targetInstance, key, value },
				});
			}
		}
	}
}

export default TargetProvisioner;
