import type { WppContact } from "@prisma/client";
import type { UserOnlineSession } from "../sdk-local";
import db from "../services/prisma.service";
import instances from "../services/instances.service";
import { ContactCustomerResolutionService } from "../services/contact-customer-resolution.service";
import type { ContactCustomerResolutionResult } from "../services/contact-customer-resolution.service";
import { distributionReads, FlowDistributionReads } from "./distribution-reads";
import type { FlowScenario } from "./simulation-scenario";

export interface SimulationReads extends FlowDistributionReads {
	contact(instance: string, id: number): Promise<WppContact | null>;
	resolveCustomer(contact: WppContact, sectorId: number): Promise<ContactCustomerResolutionResult>;
	walletName(instance: string, id: number): Promise<string | null>;
}

export const simulationReads: SimulationReads = {
	...distributionReads,
	contact: (instance, id) => db.wppContact.findFirst({ where: { instance, id, isDeleted: false } }),
	async walletName(instance, id) {
		const wallet = await db.wppWallet.findFirst({ where: { instance, id }, select: { name: true } });
		return wallet?.name ?? null;
	},
	async resolveCustomer(contact, sectorId) {
		// The resolver sees an isolated contact. Its compare-and-swap and subsequent reread happen in memory.
		let current = { ...contact };
		const resolver = new ContactCustomerResolutionService({
			sectorBelongsToInstance: async (instance, id) => instance === contact.instance && id === sectorId,
			getContact: async (instance, id) => instance === contact.instance && id === current.id ? { ...current } : null,
			query: (instance, sql, params) => instances.executeQuery(instance, sql, params, { timeoutMs: 3000 }),
			linkIfUnchanged: async (_contact, customerId) => { current = { ...current, customerId }; return 1; },
			syncContact: async () => {}
		});
		return resolver.resolve({ instance: contact.instance, sectorId }, current);
	}
};

export function scenarioReads(instance: string, sectorId: number, scenario: FlowScenario, base: SimulationReads): SimulationReads {
	return {
		...base,
		async sessions(tenant) {
			if (!scenario.onlineUserIds) return base.sessions(tenant);
			if (!scenario.onlineUserIds.length) return [];
			const operators = await base.operators(tenant, scenario.onlineUserIds);
			const rows = new Map(operators.map(row => [row.CODIGO, row]));
			return scenario.onlineUserIds.flatMap((id): UserOnlineSession[] => {
				const row = rows.get(id);
				return row ? [{ data: { userId: id, sectorId: row.SETOR, instance, name: row.NOME ?? "", role: row.NIVEL ?? "" }, isPaused: false, onlineTokens: ["simulado"] }] : [];
			});
		},
		async eligible(tenant, ids) {
			if (!scenario.pausedUserIds) return base.eligible(tenant, ids);
			const rows = await base.operators(tenant, ids);
			return new Set(rows.filter(row => row.ATIVO === "SIM" && !scenario.pausedUserIds!.includes(row.CODIGO)).map(row => row.CODIGO));
		},
		async chatCounts(tenant, ids) {
			const overrides = scenario.openChats ?? {};
			const missing = ids.filter(id => !Object.hasOwn(overrides, id));
			const counts = missing.length ? await base.chatCounts(tenant, missing) : new Map<number, number>();
			for (const id of ids) if (Object.hasOwn(overrides, id)) counts.set(id, overrides[String(id)]!);
			return counts;
		},
		loyalty: (tenant, id) => scenario.loyaltyUserId === undefined ? base.loyalty(tenant, id) : Promise.resolve(scenario.loyaltyUserId),
		async resolveCustomer(contact) {
			if (!scenario.customerStatus) return base.resolveCustomer(contact, sectorId);
			const status = scenario.customerStatus;
			if (status === "found") return { contact, resolution: { status, customerId: contact.customerId!, reason: "already_linked" } };
			return { contact, resolution: { status } };
		}
	};
}
