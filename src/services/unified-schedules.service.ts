import {
	Customer,
	CustomerProfileSummaryPayload,
	SessionData,
} from "@in.pulse-crm/sdk";
import { WppContact, WppSchedule } from "@prisma/client";
import customerProfileTagsService from "./customer-profile-tags.service";
import instancesService from "./instances.service";
import parametersService from "./parameters.service";
import prismaService from "./prisma.service";
import {
	UnifiedScheduleFilters,
	UnifiedScheduleFilterMetadata,
	UnifiedScheduleItem,
	UnifiedSchedulesResponse,
	UnifiedScheduleRepurchaseMetrics,
	UnifiedScheduleRepurchaseStatus,
} from "../types/unified-schedule.types";

interface WppScheduleWithContact extends WppSchedule {
	contact: WppContact | null;
}

interface LegacyTelephonyScheduleRow {
	CODIGO: number;
	CLIENTE: number | null;
	CAMPANHA: number | null;
	DT_AGENDAMENTO: Date | string;
	FONE1: string | null;
	FONE2: string | null;
	FONE3: string | null;
	OPERADOR: number | null;
	OPERADOR_LIGACAO: number | null;
	TELEFONE_LIGADO: string | null;
	CAMPANHA_NOME: string | null;
	CLIENTE_RAZAO: string | null;
	CLIENTE_FANTASIA: string | null;
	OPERADOR_NOME: string | null;
}

interface CustomerEnrichmentRow extends Customer {
	CUSTOMER_CAMPAIGN_NAME: string | null;
	CUSTOMER_ORIGIN_DESCRIPTION: string | null;
}

interface PurchaseRow {
	CLIENTE: number;
	DATA: string | Date | null;
}

interface BaseScheduleRecord {
	source: "WHATSAPP" | "TELEFONIA";
	uniqueId: string;
	scheduleId: number;
	scheduleAt: string;
	scheduledBy: number | null;
	scheduledFor: number | null;
	description: string | null;
	contactName: string | null;
	contactPhone: string | null;
	customerId: number | null;
	telephonyCampaignId: number | null;
	telephonyCampaignName: string | null;
	wppContactId?: number;
	wppChatId?: number | null;
	telephonyRecordId?: number;
}

class UnifiedSchedulesService {
	public async getUnifiedSchedules(
		session: SessionData,
		filters: UnifiedScheduleFilters,
	): Promise<UnifiedSchedulesResponse> {
		const page = this.parsePositiveInteger(filters.page, 1);
		const perPage = Math.min(this.parsePositiveInteger(filters.perPage, 25), 100);
		const requestedChannels = new Set(
			this.parseCsv(filters.channels)
				.map((channel) => channel.toUpperCase())
				.filter((channel) => channel === "WHATSAPP" || channel === "TELEFONIA"),
		);
		if (!requestedChannels.size) {
			requestedChannels.add("WHATSAPP");
			requestedChannels.add("TELEFONIA");
		}

		const params = await parametersService.getSessionParams(session);
		const shouldUseOldCrmSchedule = params["use_old_crm_schedule"] === "true";
		const userId = this.parsePositiveInteger(filters.userId, session.userId);
		const sectorId = this.parsePositiveInteger(filters.sectorId, session.sectorId ?? 0);

		const [whatsappSchedules, telephonySchedules] = await Promise.all([
			requestedChannels.has("WHATSAPP")
				? this.fetchWhatsappSchedules(session.instance, userId, sectorId)
				: Promise.resolve([]),
			requestedChannels.has("TELEFONIA") && shouldUseOldCrmSchedule
				? this.fetchTelephonySchedules(session.instance, userId)
				: Promise.resolve([]),
		]);

		const baseSchedules = [...whatsappSchedules, ...telephonySchedules];
		if (!baseSchedules.length) {
			return this.buildResponse([], page, perPage, 0, {
				customerCampaigns: [],
			});
		}

		const customerIds = Array.from(
			new Set(
				baseSchedules
					.map((schedule) => schedule.customerId)
					.filter((customerId): customerId is number => typeof customerId === "number" && customerId > 0),
			),
		);

		const [customerMap, profileSummaryMap, repurchaseMap] = await Promise.all([
			this.fetchCustomerEnrichments(session.instance, customerIds),
			this.fetchCustomerProfileSummaries(session.instance, customerIds),
			this.calculateRepurchaseMetrics(session.instance, customerIds),
		]);

		const campaignMetadataEligibleCustomerIds = await this.resolveEligibleCustomerIds(
			session,
			{
				...filters,
				customerCampaignIds: undefined,
			},
			customerIds,
			customerMap,
			repurchaseMap,
		);

		const eligibleCustomerIds = await this.resolveEligibleCustomerIds(
			session,
			filters,
			customerIds,
			customerMap,
			repurchaseMap,
		);

		const filteredSchedules = baseSchedules.filter((schedule) => {
			if (eligibleCustomerIds === null) {
				return true;
			}

			return typeof schedule.customerId === "number" && eligibleCustomerIds.has(schedule.customerId);
		});

		const filterMetadata = this.buildFilterMetadata(
			baseSchedules,
			customerMap,
			campaignMetadataEligibleCustomerIds,
		);

		const items = filteredSchedules
			.map<UnifiedScheduleItem>((schedule) => {
				const customer = typeof schedule.customerId === "number"
					? customerMap.get(schedule.customerId) ?? null
					: null;
				const profileSummary = typeof schedule.customerId === "number"
					? profileSummaryMap.get(schedule.customerId) ?? null
					: null;
				const repurchase = typeof schedule.customerId === "number"
					? repurchaseMap.get(schedule.customerId) ?? null
					: null;

				return {
					id: schedule.uniqueId,
					channel: schedule.source,
					scheduleId: schedule.scheduleId,
					scheduleAt: schedule.scheduleAt,
					scheduledBy: schedule.scheduledBy,
					scheduledFor: schedule.scheduledFor,
					description: schedule.description,
					contactName: schedule.contactName,
					contactPhone: schedule.contactPhone,
					customerId: schedule.customerId,
					customerName: customer?.RAZAO ?? null,
					customerFantasyName: customer?.FANTASIA ?? null,
					customerCampaignId: customer?.COD_CAMPANHA ?? null,
					customerCampaignName: customer?.CUSTOMER_CAMPAIGN_NAME ?? null,
					customerOriginId: customer?.ORIGEM ?? null,
					customerOriginDescription: customer?.CUSTOMER_ORIGIN_DESCRIPTION ?? null,
					telephonyCampaignId: schedule.telephonyCampaignId,
					telephonyCampaignName: schedule.telephonyCampaignName,
					profileSummary,
					repurchase,
					meta: {
						wppContactId: schedule.wppContactId,
						wppChatId: schedule.wppChatId,
						telephonyRecordId: schedule.telephonyRecordId,
					},
				};
			})
			.sort((first, second) => new Date(first.scheduleAt).getTime() - new Date(second.scheduleAt).getTime());

		return this.buildResponse(items, page, perPage, items.length, filterMetadata);
	}

	private async fetchWhatsappSchedules(
		instance: string,
		userId: number,
		sectorId: number,
	): Promise<BaseScheduleRecord[]> {
		const schedules = await prismaService.wppSchedule.findMany({
			where: {
				instance,
				chat: null,
				scheduledFor: userId,
				sectorId,
			},
			include: {
				contact: true,
			},
		}) as WppScheduleWithContact[];

		return schedules.map((schedule) => ({
			source: "WHATSAPP",
			uniqueId: `WHATSAPP-${schedule.id}`,
			scheduleId: schedule.id,
			scheduleAt: schedule.scheduleDate.toISOString(),
			scheduledBy: schedule.scheduledBy,
			scheduledFor: schedule.scheduledFor,
			description: schedule.description,
			contactName: schedule.contact?.name ?? null,
			contactPhone: schedule.contact?.phone ?? null,
			customerId: schedule.contact?.customerId ?? null,
			telephonyCampaignId: null,
			telephonyCampaignName: null,
			wppContactId: schedule.contactId,
			wppChatId: schedule.chatId,
		}));
	}

	private async fetchTelephonySchedules(instance: string, userId: number): Promise<BaseScheduleRecord[]> {
		const rows = await instancesService.executeQuery<LegacyTelephonyScheduleRow[]>(
			instance,
			[
				"SELECT cc.CODIGO, cc.CLIENTE, cc.CAMPANHA, cc.DT_AGENDAMENTO, cc.FONE1, cc.FONE2, cc.FONE3,",
				"cc.OPERADOR, cc.OPERADOR_LIGACAO, cc.TELEFONE_LIGADO, camp.NOME AS CAMPANHA_NOME,",
				"cli.RAZAO AS CLIENTE_RAZAO, cli.FANTASIA AS CLIENTE_FANTASIA, op.NOME AS OPERADOR_NOME",
				"FROM campanhas_clientes cc",
				"LEFT JOIN campanhas camp ON camp.CODIGO = cc.CAMPANHA",
				"LEFT JOIN clientes cli ON cli.CODIGO = cc.CLIENTE",
				"LEFT JOIN operadores op ON op.CODIGO = cc.OPERADOR",
				"WHERE cc.OPERADOR = ?",
				"AND cc.DT_AGENDAMENTO IS NOT NULL",
				"AND (cc.CONCLUIDO = 'NAO' OR cc.CONCLUIDO IS NULL)",
			].join(" "),
			[userId],
		);

		return rows.map((row) => ({
			source: "TELEFONIA",
			uniqueId: `TELEFONIA-${row.CODIGO}`,
			scheduleId: row.CODIGO,
			scheduleAt: this.toIsoString(row.DT_AGENDAMENTO),
			scheduledBy: row.OPERADOR,
			scheduledFor: row.OPERADOR_LIGACAO,
			description: row.OPERADOR_NOME ? `Operador: ${row.OPERADOR_NOME}` : null,
			contactName: row.CLIENTE_RAZAO ?? row.CLIENTE_FANTASIA,
			contactPhone: row.TELEFONE_LIGADO ?? row.FONE1 ?? row.FONE2 ?? row.FONE3,
			customerId: row.CLIENTE,
			telephonyCampaignId: row.CAMPANHA,
			telephonyCampaignName: row.CAMPANHA_NOME,
			telephonyRecordId: row.CODIGO,
		}));
	}

	private async fetchCustomerEnrichments(
		instance: string,
		customerIds: number[],
	): Promise<Map<number, CustomerEnrichmentRow>> {
		if (!customerIds.length) {
			return new Map();
		}

		const customers = await instancesService.executeQuery<CustomerEnrichmentRow[]>(
			instance,
			[
				"SELECT c.*, camp.NOME AS CUSTOMER_CAMPAIGN_NAME, org.DESCRICAO AS CUSTOMER_ORIGIN_DESCRIPTION",
				"FROM clientes c",
				"LEFT JOIN campanhas camp ON camp.CODIGO = c.COD_CAMPANHA",
				"LEFT JOIN origens_sgr org ON org.CODIGO = c.ORIGEM",
				"WHERE c.CODIGO IN (?)",
			].join(" "),
			[customerIds],
		);

		return new Map(customers.map((customer) => [customer.CODIGO, customer]));
	}

	private async fetchCustomerProfileSummaries(
		instance: string,
		customerIds: number[],
	): Promise<Map<number, CustomerProfileSummaryPayload>> {
		if (!customerIds.length) {
			return new Map();
		}

		const summaries = await customerProfileTagsService.getCustomerProfileSummaries(instance, customerIds);
		return new Map(summaries.map((summary) => [summary.customerId, summary]));
	}

	private async resolveEligibleCustomerIds(
		session: SessionData,
		filters: UnifiedScheduleFilters,
		candidateCustomerIds: number[],
		customerMap: Map<number, CustomerEnrichmentRow>,
		repurchaseMap: Map<number, UnifiedScheduleRepurchaseMetrics>,
	): Promise<Set<number> | null> {
		if (!candidateCustomerIds.length) {
			return new Set();
		}

		let eligible = new Set(candidateCustomerIds);
		let hasCustomerScopedFilter = false;

		const profileFilteredIds = await this.resolveProfileFilteredCustomerIds(session.instance, filters);
		if (profileFilteredIds !== null) {
			hasCustomerScopedFilter = true;
			eligible = this.intersectSets(eligible, profileFilteredIds);
		}

		const campaignIds = this.parseCsv(filters.customerCampaignIds)
			.map((value) => Number(value))
			.filter((value) => Number.isInteger(value) && value > 0);
		if (campaignIds.length) {
			hasCustomerScopedFilter = true;
			const campaignIdSet = new Set(campaignIds);
			eligible = new Set(
				[...eligible].filter((customerId) => {
					const customer = customerMap.get(customerId);
					return typeof customer?.COD_CAMPANHA === "number" && campaignIdSet.has(customer.COD_CAMPANHA);
				}),
			);
		}

		const repurchaseStatuses = this.parseCsv(filters.repurchaseStatuses)
			.map((status) => status.toLowerCase())
			.filter((status): status is UnifiedScheduleRepurchaseStatus =>
				status === "green" || status === "yellow" || status === "red" || status === "neutral",
			);
		if (repurchaseStatuses.length) {
			hasCustomerScopedFilter = true;
			const repurchaseStatusSet = new Set(repurchaseStatuses);
			eligible = new Set(
				[...eligible].filter((customerId) => {
					const metrics = repurchaseMap.get(customerId);
					return metrics ? repurchaseStatusSet.has(metrics.semaphoreStatus) : repurchaseStatusSet.has("neutral");
				}),
			);
		}

		return hasCustomerScopedFilter ? eligible : null;
	}

	private async resolveProfileFilteredCustomerIds(
		instance: string,
		filters: UnifiedScheduleFilters,
	): Promise<Set<number> | null> {
		const profileFilters = {
			profileLevel: filters.profileLevel,
			interactionLevel: filters.interactionLevel,
			purchaseLevel: filters.purchaseLevel,
			ageLevel: filters.ageLevel,
			purchaseInterestLevel: filters.purchaseInterestLevel,
		};
		const hasActiveFilters = Object.values(profileFilters).some((value) => value != null);
		if (!hasActiveFilters) {
			return null;
		}

		const customerIds = await customerProfileTagsService.findCustomerIdsByProfileFilters(instance, profileFilters);
		return new Set(customerIds);
	}

	private async calculateRepurchaseMetrics(
		instance: string,
		customerIds: number[],
	): Promise<Map<number, UnifiedScheduleRepurchaseMetrics>> {
		if (!customerIds.length) {
			return new Map();
		}

		const purchases = await instancesService.executeQuery<PurchaseRow[]>(
			instance,
			[
				"SELECT CLIENTE, DATA",
				"FROM compras",
				"WHERE CLIENTE IN (?)",
				"ORDER BY CLIENTE ASC, DATA ASC",
			].join(" "),
			[customerIds],
		);

		const purchasesByCustomer = new Map<number, Date[]>();
		for (const purchase of purchases) {
			if (!purchase.DATA) {
				continue;
			}

			const list = purchasesByCustomer.get(purchase.CLIENTE) ?? [];
			list.push(new Date(purchase.DATA));
			purchasesByCustomer.set(purchase.CLIENTE, list);
		}

		const metricsMap = new Map<number, UnifiedScheduleRepurchaseMetrics>();
		for (const customerId of customerIds) {
			const parsedPurchases = purchasesByCustomer.get(customerId) ?? [];
			const intervals: number[] = [];

			for (let index = 1; index < parsedPurchases.length; index += 1) {
				const currentPurchase = parsedPurchases[index];
				const previousPurchase = parsedPurchases[index - 1];
				if (!currentPurchase || !previousPurchase) {
					continue;
				}

				intervals.push(
					Math.max(1, Math.round((currentPurchase.getTime() - previousPurchase.getTime()) / 86400000)),
				);
			}

			const averageRepurchaseDays = intervals.length
				? intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length
				: null;
			const lastPurchase = parsedPurchases.at(-1) ?? null;
			const daysSinceLastPurchase = lastPurchase
				? Math.max(0, Math.round((Date.now() - lastPurchase.getTime()) / 86400000))
				: null;
			const nextRepurchaseDate = lastPurchase && averageRepurchaseDays
				? new Date(lastPurchase.getTime() + averageRepurchaseDays * 86400000)
				: null;
			const proximityRatio = averageRepurchaseDays && daysSinceLastPurchase != null
				? daysSinceLastPurchase / averageRepurchaseDays
				: null;

			let semaphoreStatus: UnifiedScheduleRepurchaseStatus = "neutral";
			if (proximityRatio != null) {
				if (proximityRatio < 0.75) {
					semaphoreStatus = "green";
				} else if (proximityRatio <= 1) {
					semaphoreStatus = "yellow";
				} else {
					semaphoreStatus = "red";
				}
			}

			metricsMap.set(customerId, {
				averageRepurchaseDays,
				daysSinceLastPurchase,
				nextRepurchaseDate: nextRepurchaseDate ? nextRepurchaseDate.toISOString() : null,
				proximityRatio,
				semaphoreStatus,
				overdueDays: nextRepurchaseDate
					? Math.max(0, Math.round((Date.now() - nextRepurchaseDate.getTime()) / 86400000))
					: null,
			});
		}

		return metricsMap;
	}

	private buildFilterMetadata(
		baseSchedules: BaseScheduleRecord[],
		customerMap: Map<number, CustomerEnrichmentRow>,
		eligibleCustomerIds: Set<number> | null,
	): UnifiedScheduleFilterMetadata {
		const campaignMap = new Map<string, { id: string; label: string }>();

		for (const schedule of baseSchedules) {
			if (typeof schedule.customerId !== "number") {
				continue;
			}

			if (eligibleCustomerIds && !eligibleCustomerIds.has(schedule.customerId)) {
				continue;
			}

			const customer = customerMap.get(schedule.customerId);
			if (typeof customer?.COD_CAMPANHA !== "number" || !customer.CUSTOMER_CAMPAIGN_NAME) {
				continue;
			}

			campaignMap.set(String(customer.COD_CAMPANHA), {
				id: String(customer.COD_CAMPANHA),
				label: customer.CUSTOMER_CAMPAIGN_NAME,
			});
		}

		return {
			customerCampaigns: Array.from(campaignMap.values()).sort((first, second) =>
				first.label.localeCompare(second.label, "pt-BR")
			),
		};
	}

	private buildResponse(
		items: UnifiedScheduleItem[],
		page: number,
		perPage: number,
		totalRows: number,
		filterMetadata: UnifiedScheduleFilterMetadata,
	): UnifiedSchedulesResponse {
		const totalPages = Math.max(1, Math.ceil(totalRows / perPage));
		const currentPage = Math.min(page, totalPages);
		const offset = (currentPage - 1) * perPage;
		const pagedItems = items.slice(offset, offset + perPage);

		return {
			message: "Unified schedules retrieved successfully!",
			data: pagedItems,
			page: {
				current: currentPage,
				totalRows,
			},
			pagination: {
				current: currentPage,
				perPage,
				totalRows,
				totalPages,
				hasNext: currentPage < totalPages,
				hasPrev: currentPage > 1,
			},
			filters: filterMetadata,
		};
	}

	private parsePositiveInteger(value: string | undefined, fallback: number): number {
		const parsed = Number(value);
		return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
	}

	private parseCsv(value: string | undefined): string[] {
		if (!value) {
			return [];
		}

		return value.split(",").map((item) => item.trim()).filter(Boolean);
	}

	private intersectSets(base: Set<number>, next: Set<number>): Set<number> {
		return new Set([...base].filter((value) => next.has(value)));
	}

	private toIsoString(value: string | Date): string {
		const date = value instanceof Date ? value : new Date(value);
		return date.toISOString();
	}
}

export default new UnifiedSchedulesService();