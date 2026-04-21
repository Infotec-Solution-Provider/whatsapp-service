import { CustomerProfileTag, CustomerProfileTagType, Prisma } from "@prisma/client";
import instancesService from "./instances.service";
import prismaService from "./prisma.service";
import {
	AGE_TAG_TYPE,
	CustomerAgeLevel,
	CustomerAgeTagMetrics,
	CustomerInteractionLevel,
	CustomerInteractionTagMetrics,
	CustomerProfileManualOverrides,
	CustomerPurchaseInterestLevel,
	CustomerPurchaseInterestPayload,
	CustomerProfileSummaryFilters,
	CustomerProfileTagMetadata,
	CustomerProfileSummaryLevel,
	CustomerProfileSummaryPayload,
	CustomerPurchaseLevel,
	CustomerPurchaseTagMetrics,
	CustomerProfileTagPayload,
	UpdateCustomerProfileManualOverridesInput,
	INTERACTION_TAG_TYPE,
	PURCHASE_TAG_TYPE,
} from "../types/customer-profile-tag.types";

const INTERACTION_WINDOW_DAYS = 90;
const PURCHASE_WINDOW_MONTHS = 12;
const NEW_CUSTOMER_WINDOW_DAYS = 30;
const INTERACTION_TAG_CONFIG: Record<CustomerInteractionLevel, { label: string; color: string }> = {
	sem_interacao: {
		label: "Sem interacao",
		color: "#6b7280",
	},
	pouca_interacao: {
		label: "Pouca interacao",
		color: "#d97706",
	},
	interacao_media: {
		label: "Interacao media",
		color: "#2563eb",
	},
	interacao_alta: {
		label: "Interacao alta",
		color: "#15803d",
	},
};
const PURCHASE_TAG_CONFIG: Record<CustomerPurchaseLevel, { label: string; color: string }> = {
	sem_compras: {
		label: "Sem compras",
		color: "#6b7280",
	},
	poucas_compras: {
		label: "Poucas compras",
		color: "#d97706",
	},
	compras_medias: {
		label: "Compras medias",
		color: "#2563eb",
	},
	muitas_compras: {
		label: "Muitas compras",
		color: "#15803d",
	},
};
const AGE_TAG_CONFIG: Record<CustomerAgeLevel, { label: string; color: string }> = {
	sem_data_cadastro: {
		label: "Sem data cadastro",
		color: "#6b7280",
	},
	cliente_novo: {
		label: "Cliente novo",
		color: "#ea580c",
	},
	ate_6_meses: {
		label: "Ate 6 meses",
		color: "#d97706",
	},
	ate_12_meses: {
		label: "Ate 12 meses",
		color: "#2563eb",
	},
	mais_de_12_meses: {
		label: "Mais de 12 meses",
		color: "#15803d",
	},
};
const PROFILE_SUMMARY_CONFIG: Record<CustomerProfileSummaryLevel, { label: string; color: string }> = {
	potencial_de_compra: {
		label: "Potencial de compra",
		color: "#7c3aed",
	},
	consolidado: {
		label: "Consolidado",
		color: "#15803d",
	},
	precisa_mais_interacao: {
		label: "Precisa mais interacao",
		color: "#d97706",
	},
	em_observacao: {
		label: "Em observacao",
		color: "#475569",
	},
};
const PURCHASE_INTEREST_CONFIG: Record<CustomerPurchaseInterestLevel, { label: string; color: string }> = {
	nao_analisado: {
		label: "Nao analisado IA",
		color: "#64748b",
	},
	baixo_interesse: {
		label: "Baixo interesse",
		color: "#94a3b8",
	},
	interesse_moderado: {
		label: "Interesse moderado",
		color: "#2563eb",
	},
	alto_interesse: {
		label: "Alto interesse",
		color: "#ea580c",
	},
	pronto_para_compra: {
		label: "Pronto para compra",
		color: "#15803d",
	},
};

interface RecentInteractionAggregateRow {
	activeDays: bigint | number | null;
	activeContacts: bigint | number | null;
}

interface PurchaseAggregateRow {
	allTimePurchaseCount: bigint | number | null;
	purchaseCount12m: bigint | number | null;
	totalPurchaseValue12m: number | string | null;
	lastPurchaseAt: Date | string | null;
}

interface CustomerRegistrationRow {
	registeredAt: Date | string | null;
}

interface CustomerIdRow {
	CODIGO: bigint | number;
}

interface PurchaseTagMetadataWithManualOverrides extends CustomerPurchaseTagMetrics {
	manualOverrides?: CustomerProfileManualOverrides | null;
}

class CustomerProfileTagsService {
	private readonly profileSummaryBatchSize = 25;

	private shouldRefreshInteractionSnapshot(existing: CustomerProfileTagPayload | null): boolean {
		if (!existing) {
			return true;
		}

		const metadata = existing.metadata;
		if (!metadata || typeof metadata !== "object") {
			return true;
		}

		const interactionMetadata = metadata as Partial<CustomerInteractionTagMetrics>;
		return typeof interactionMetadata.recentActiveDays90d !== "number";
	}

	private buildInteractionReasons(metrics: Omit<CustomerInteractionTagMetrics, "reasons">): string[] {
		const reasons: string[] = [];

		if (metrics.contactCount === 0) {
			reasons.push("noLinkedWhatsappContacts");
		}

		if (metrics.messageCount90d === 0) {
			reasons.push("noRecentInteraction");
		} else if (metrics.recentActiveDays90d <= 1 && metrics.chatCount90d <= 1) {
			reasons.push("singleRecentTouch");
		} else if (metrics.recentActiveDays90d <= 3 && metrics.chatCount90d <= 2) {
			reasons.push("recurringRecentInteraction");
		} else {
			reasons.push("highRecurrenceRecentInteraction");
		}

		if (metrics.messageCount90d >= 30 && metrics.recentActiveDays90d <= 1 && metrics.chatCount90d <= 1) {
			reasons.push("highVolumeSingleConversation");
		}

		if (metrics.chatCount90d > 1) {
			reasons.push("multipleRecentChats");
		}

		if (metrics.recentActiveDays90d > 1) {
			reasons.push("multipleActiveDays");
		}

		if (metrics.activeContactCount > 1) {
			reasons.push("multipleRecentContacts");
		} else if (metrics.contactCount > 1) {
			reasons.push("multipleLinkedContacts");
		}

		return reasons;
	}

	private buildPurchaseReasons(metrics: Omit<CustomerPurchaseTagMetrics, "reasons">): string[] {
		const reasons: string[] = [];

		if (metrics.allTimePurchaseCount === 0) {
			reasons.push("noPurchaseHistory");
			return reasons;
		}

		if (metrics.daysSinceLastPurchase === null) {
			reasons.push("unknownLastPurchaseDate");
			return reasons;
		}

		if (metrics.daysSinceLastPurchase <= 90) {
			reasons.push("recentPurchase");
		} else if (metrics.daysSinceLastPurchase <= 180) {
			reasons.push("moderatelyRecentPurchase");
		} else if (metrics.daysSinceLastPurchase > 365) {
			reasons.push("stalePurchaseHistory");
		}

		if (metrics.purchaseCount12m >= 5) {
			reasons.push("highPurchaseFrequency");
		} else if (metrics.purchaseCount12m >= 2) {
			reasons.push("recurringPurchase");
		} else if (metrics.purchaseCount12m === 1) {
			reasons.push("singlePurchaseLastYear");
		}

		return reasons;
	}

	private shouldRefreshCustomerAgeSnapshot(existing: CustomerProfileTagPayload | null): boolean {
		if (!existing) {
			return true;
		}

		const metadata = existing.metadata;
		if (!metadata || typeof metadata !== "object") {
			return true;
		}

		const ageMetadata = metadata as Partial<CustomerAgeTagMetrics>;
		return !("customerAgeMonths" in ageMetadata) || !("customerAgeDays" in ageMetadata);
	}

	private buildCustomerAgeReasons(metrics: Omit<CustomerAgeTagMetrics, "reasons">): string[] {
		if (!metrics.registeredAt || metrics.customerAgeDays === null || metrics.customerAgeMonths === null) {
			return ["missingRegistrationDate"];
		}

		if (metrics.customerAgeDays <= NEW_CUSTOMER_WINDOW_DAYS) {
			return ["newlyRegistered"];
		}

		if (metrics.customerAgeMonths <= 6) {
			return ["registeredWithinSixMonths"];
		}

		if (metrics.customerAgeMonths <= 12) {
			return ["registeredWithinTwelveMonths"];
		}

		return ["longTermCustomer"];
	}

	private resolveInteractionLevel(metrics: Omit<CustomerInteractionTagMetrics, "reasons">): CustomerInteractionLevel {
		if (metrics.contactCount === 0 || (metrics.chatCount90d === 0 && metrics.messageCount90d === 0)) {
			return "sem_interacao";
		}

		const hasModerateRecurrence =
			metrics.recentActiveDays90d >= 2 ||
			metrics.chatCount90d >= 2 ||
			metrics.activeContactCount >= 2;

		const hasStrongRecurrence =
			metrics.recentActiveDays90d >= 4 ||
			metrics.chatCount90d >= 3 ||
			metrics.activeContactCount >= 2;

		if (!hasModerateRecurrence && metrics.messageCount90d <= 20) {
			return "pouca_interacao";
		}

		if (hasStrongRecurrence && metrics.messageCount90d >= 15) {
			return "interacao_alta";
		}

		return "interacao_media";
	}

	private resolvePurchaseLevel(metrics: Omit<CustomerPurchaseTagMetrics, "reasons">): CustomerPurchaseLevel {
		if (metrics.allTimePurchaseCount === 0) {
			return "sem_compras";
		}

		const daysSinceLastPurchase = metrics.daysSinceLastPurchase;
		if (daysSinceLastPurchase === null) {
			return "poucas_compras";
		}

		if (metrics.purchaseCount12m >= 5 || (metrics.purchaseCount12m >= 2 && daysSinceLastPurchase <= 90)) {
			return "muitas_compras";
		}

		if (metrics.purchaseCount12m >= 2 || daysSinceLastPurchase <= 180) {
			return "compras_medias";
		}

		return "poucas_compras";
	}

	private resolveCustomerAgeLevel(metrics: Omit<CustomerAgeTagMetrics, "reasons">): CustomerAgeLevel {
		if (!metrics.registeredAt || metrics.customerAgeDays === null || metrics.customerAgeMonths === null) {
			return "sem_data_cadastro";
		}

		if (metrics.customerAgeDays <= NEW_CUSTOMER_WINDOW_DAYS) {
			return "cliente_novo";
		}

		if (metrics.customerAgeMonths <= 6) {
			return "ate_6_meses";
		}

		if (metrics.customerAgeMonths <= 12) {
			return "ate_12_meses";
		}

		return "mais_de_12_meses";
	}

	private normalizePayload(snapshot: CustomerProfileTag): CustomerProfileTagPayload<CustomerProfileTagMetadata> {
		return {
			id: snapshot.id,
			instance: snapshot.instance,
			customerId: snapshot.customerId,
			tagType:
				snapshot.tagType === "INTERACTION_LEVEL"
					? INTERACTION_TAG_TYPE
					: snapshot.tagType === "PURCHASE_LEVEL"
						? PURCHASE_TAG_TYPE
						: snapshot.tagType === "CUSTOMER_AGE"
							? AGE_TAG_TYPE
							: snapshot.tagType,
			tagValue: snapshot.tagValue,
			label: snapshot.label,
			color: snapshot.color,
			calculatedAt: snapshot.calculatedAt.toISOString(),
			metadata: (snapshot.metadataJson as CustomerProfileTagMetadata | null) ?? null,
		};
	}

	private extractManualOverrides(metadata: CustomerProfileTagMetadata | null): CustomerProfileManualOverrides | null {
		if (!metadata || typeof metadata !== "object") {
			return null;
		}

		const manualOverrides = (metadata as PurchaseTagMetadataWithManualOverrides).manualOverrides;
		if (!manualOverrides || typeof manualOverrides !== "object") {
			return null;
		}

		return manualOverrides;
	}

	private stripManualOverrides(metadata: CustomerProfileTagMetadata | null): CustomerPurchaseTagMetrics {
		const source = metadata && typeof metadata === "object" ? { ...metadata } : {};
		delete (source as { manualOverrides?: unknown }).manualOverrides;

		return source as CustomerPurchaseTagMetrics;
	}

	private mergePurchaseMetadataWithManualOverrides(
		metrics: CustomerPurchaseTagMetrics,
		manualOverrides: CustomerProfileManualOverrides | null
	): Prisma.InputJsonValue {
		if (!manualOverrides) {
			return metrics as unknown as Prisma.InputJsonValue;
		}

		return {
			...metrics,
			manualOverrides,
		} as Prisma.InputJsonValue;
	}

	private buildManualProfileSummaryReasons(
		computedReasons: string[],
		manualOverrides: CustomerProfileManualOverrides | null,
		profileLevel: CustomerProfileSummaryLevel
	): string[] {
		if (!manualOverrides?.profileLevel) {
			return computedReasons;
		}

		return [
			...computedReasons,
			`manualProfileOverride:${profileLevel}`,
			`manualBy:${manualOverrides.updatedByName}`,
		];
	}

	private buildManualPurchaseInterestPayload(
		manualOverrides: CustomerProfileManualOverrides,
		interactionTag: CustomerProfileTagPayload<CustomerInteractionTagMetrics>,
		purchaseTag: CustomerProfileTagPayload<CustomerPurchaseTagMetrics>,
		ageTag: CustomerProfileTagPayload<CustomerAgeTagMetrics>
	): CustomerPurchaseInterestPayload {
		const level = manualOverrides.purchaseInterestLevel as CustomerPurchaseInterestLevel;
		const config = PURCHASE_INTEREST_CONFIG[level];

		return {
			level,
			label: config.label,
			color: config.color,
			reasons: [
				...this.buildPurchaseInterestReasons(interactionTag, purchaseTag, ageTag, level),
				`manualPurchaseInterestOverride:${level}`,
				`manualBy:${manualOverrides.updatedByName}`,
			],
			source: "manual_override",
		};
	}

	private buildResolvedProfileSummary(
		instance: string,
		customerId: number,
		interactionTag: CustomerProfileTagPayload<CustomerInteractionTagMetrics>,
		purchaseTag: CustomerProfileTagPayload<CustomerPurchaseTagMetrics>,
		ageTag: CustomerProfileTagPayload<CustomerAgeTagMetrics>
	): CustomerProfileSummaryPayload {
		const computedProfileLevel = this.resolveProfileSummaryLevel(
			interactionTag.tagValue,
			purchaseTag.tagValue,
			ageTag.tagValue
		);
		const manualOverrides = this.extractManualOverrides(purchaseTag.metadata);
		const profileLevel = manualOverrides?.profileLevel ?? computedProfileLevel;
		const profileConfig = PROFILE_SUMMARY_CONFIG[profileLevel];
		const computedReasons = this.buildProfileSummaryReasons(interactionTag, purchaseTag, ageTag);
		const purchaseInterest = manualOverrides?.purchaseInterestLevel
			? this.buildManualPurchaseInterestPayload(manualOverrides, interactionTag, purchaseTag, ageTag)
			: this.buildPurchaseInterestPayload(interactionTag, purchaseTag, ageTag);

		return {
			instance,
			customerId,
			profileLevel,
			label: profileConfig.label,
			color: profileConfig.color,
			profileSource: manualOverrides?.profileLevel ? "manual_override" : "automatic",
			reasons: this.buildManualProfileSummaryReasons(computedReasons, manualOverrides, profileLevel),
			purchaseInterest,
			manualOverrides,
			tags: {
				interaction: interactionTag,
				purchase: purchaseTag,
				age: ageTag,
			},
		};
	}

	private calculateMonthDiff(startDate: Date, endDate: Date): number {
		let totalMonths =
			(endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
			(endDate.getUTCMonth() - startDate.getUTCMonth());

		if (endDate.getUTCDate() < startDate.getUTCDate()) {
			totalMonths -= 1;
		}

		return Math.max(0, totalMonths);
	}

	private buildProfileSummaryReasons(
		interactionTag: CustomerProfileTagPayload<CustomerInteractionTagMetrics>,
		purchaseTag: CustomerProfileTagPayload<CustomerPurchaseTagMetrics>,
		ageTag: CustomerProfileTagPayload<CustomerAgeTagMetrics>
	): string[] {
		const reasons = [
			`interaction:${interactionTag.tagValue}`,
			`purchase:${purchaseTag.tagValue}`,
			`age:${ageTag.tagValue}`,
		];

		if (
			(purchaseTag.tagValue === "compras_medias" || purchaseTag.tagValue === "muitas_compras") &&
			(interactionTag.tagValue === "interacao_media" || interactionTag.tagValue === "interacao_alta")
		) {
			reasons.push("hasPurchaseConsistency");
		}

		if (
			(purchaseTag.tagValue === "sem_compras" || purchaseTag.tagValue === "poucas_compras") &&
			(interactionTag.tagValue === "interacao_media" || interactionTag.tagValue === "interacao_alta")
		) {
			reasons.push("engagedButStillUnderbuying");
		}

		if (
			(ageTag.tagValue === "cliente_novo" || ageTag.tagValue === "ate_6_meses") &&
			(interactionTag.tagValue === "sem_interacao" || interactionTag.tagValue === "pouca_interacao")
		) {
			reasons.push("earlyRelationshipNeedsNurture");
		}

		return reasons;
	}

	private resolveProfileSummaryLevel(
		interactionLevel: string,
		purchaseLevel: string,
		ageLevel: string
	): CustomerProfileSummaryLevel {
		if (
			(purchaseLevel === "compras_medias" || purchaseLevel === "muitas_compras") &&
			(interactionLevel === "interacao_media" || interactionLevel === "interacao_alta")
		) {
			return "consolidado";
		}

		if (
			(purchaseLevel === "sem_compras" || purchaseLevel === "poucas_compras") &&
			(interactionLevel === "interacao_media" || interactionLevel === "interacao_alta")
		) {
			return "potencial_de_compra";
		}

		if (
			(ageLevel === "cliente_novo" || ageLevel === "ate_6_meses") &&
			(interactionLevel === "sem_interacao" || interactionLevel === "pouca_interacao")
		) {
			return "precisa_mais_interacao";
		}

		return "em_observacao";
	}

	private buildPurchaseInterestReasons(
		interactionTag: CustomerProfileTagPayload<CustomerInteractionTagMetrics>,
		purchaseTag: CustomerProfileTagPayload<CustomerPurchaseTagMetrics>,
		ageTag: CustomerProfileTagPayload<CustomerAgeTagMetrics>,
		interestLevel: CustomerPurchaseInterestLevel
	): string[] {
		const reasons = [
			`interest:${interestLevel}`,
			`interaction:${interactionTag.tagValue}`,
			`purchase:${purchaseTag.tagValue}`,
			`age:${ageTag.tagValue}`,
		];

		if (interestLevel === "nao_analisado") {
			reasons.push("placeholderWithoutEnoughSignals");
		}

		if (interestLevel === "alto_interesse" || interestLevel === "pronto_para_compra") {
			reasons.push("highEngagementSignal");
		}

		if (ageTag.tagValue === "cliente_novo" || ageTag.tagValue === "ate_6_meses") {
			reasons.push("recentRelationshipMomentum");
		}

		return reasons;
	}

	private resolvePurchaseInterestLevel(
		interactionLevel: string,
		purchaseLevel: string,
		ageLevel: string
	): CustomerPurchaseInterestLevel {
		if (
			interactionLevel === "sem_interacao" &&
			purchaseLevel === "sem_compras" &&
			ageLevel === "sem_data_cadastro"
		) {
			return "nao_analisado";
		}

		if (
			(purchaseLevel === "compras_medias" || purchaseLevel === "muitas_compras") &&
			(interactionLevel === "interacao_media" || interactionLevel === "interacao_alta")
		) {
			return "pronto_para_compra";
		}

		if (interactionLevel === "interacao_alta") {
			return "alto_interesse";
		}

		if (
			interactionLevel === "interacao_media" ||
			ageLevel === "cliente_novo" ||
			ageLevel === "ate_6_meses"
		) {
			return "interesse_moderado";
		}

		return "baixo_interesse";
	}

	private buildPurchaseInterestPayload(
		interactionTag: CustomerProfileTagPayload<CustomerInteractionTagMetrics>,
		purchaseTag: CustomerProfileTagPayload<CustomerPurchaseTagMetrics>,
		ageTag: CustomerProfileTagPayload<CustomerAgeTagMetrics>
	): CustomerPurchaseInterestPayload {
		const level = this.resolvePurchaseInterestLevel(
			interactionTag.tagValue,
			purchaseTag.tagValue,
			ageTag.tagValue
		);
		const config = PURCHASE_INTEREST_CONFIG[level];

		return {
			level,
			label: config.label,
			color: config.color,
			reasons: this.buildPurchaseInterestReasons(interactionTag, purchaseTag, ageTag, level),
			source: "placeholder_rules",
		};
	}

	private matchesSummaryFilters(
		tags: {
			interaction?: CustomerProfileTagPayload<CustomerInteractionTagMetrics>;
			purchase?: CustomerProfileTagPayload<CustomerPurchaseTagMetrics>;
			age?: CustomerProfileTagPayload<CustomerAgeTagMetrics>;
		},
		filters: CustomerProfileSummaryFilters
	): boolean {
		if (filters.interactionLevel && tags.interaction?.tagValue !== filters.interactionLevel) {
			return false;
		}

		if (filters.purchaseLevel && tags.purchase?.tagValue !== filters.purchaseLevel) {
			return false;
		}

		if (filters.ageLevel && tags.age?.tagValue !== filters.ageLevel) {
			return false;
		}

		if (filters.purchaseInterestLevel && filters.purchaseInterestLevel !== "nao_analisado") {
			if (!tags.interaction || !tags.purchase || !tags.age) {
				return false;
			}

			const manualOverrides = this.extractManualOverrides(tags.purchase.metadata);
			const purchaseInterest = manualOverrides?.purchaseInterestLevel ?? this.resolvePurchaseInterestLevel(
				tags.interaction.tagValue,
				tags.purchase.tagValue,
				tags.age.tagValue
			);

			if (purchaseInterest !== filters.purchaseInterestLevel) {
				return false;
			}
		}

		if (!filters.profileLevel) {
			return true;
		}

		if (!tags.interaction || !tags.purchase || !tags.age) {
			return false;
		}

		const manualOverrides = this.extractManualOverrides(tags.purchase.metadata);
		const profileLevel = manualOverrides?.profileLevel ?? this.resolveProfileSummaryLevel(
			tags.interaction.tagValue,
			tags.purchase.tagValue,
			tags.age.tagValue
		);

		return profileLevel === filters.profileLevel;
	}

	private hasComputedSummaryFilters(filters: CustomerProfileSummaryFilters): boolean {
		return Boolean(
			filters.profileLevel ||
				filters.interactionLevel ||
				filters.purchaseLevel ||
				filters.ageLevel ||
				(filters.purchaseInterestLevel && filters.purchaseInterestLevel !== "nao_analisado")
		);
	}

	private chunkNumbers(values: number[], chunkSize: number): number[][] {
		const chunks: number[][] = [];

		for (let index = 0; index < values.length; index += chunkSize) {
			chunks.push(values.slice(index, index + chunkSize));
		}

		return chunks;
	}

	private async listAllCustomerIds(instance: string): Promise<number[]> {
		const rows = await instancesService.executeQuery<CustomerIdRow[]>(
			instance,
			["SELECT CODIGO", "FROM clientes", "ORDER BY CODIGO ASC"].join(" "),
			[]
		);

		return rows.map((row) => Number(row.CODIGO)).filter((customerId) => Number.isInteger(customerId) && customerId > 0);
	}

	private async listCustomerIdsByBaseFilters(
		instance: string,
		filters: CustomerProfileSummaryFilters
	): Promise<number[] | null> {
		const conditions: string[] = [];
		const bindings: Array<string | number> = [];

		if (filters.state?.trim()) {
			conditions.push("UPPER(ESTADO) = ?");
			bindings.push(filters.state.trim().toUpperCase());
		}

		if (filters.city?.trim()) {
			conditions.push("CIDADE = ?");
			bindings.push(filters.city.trim());
		}

		if (filters.activeCustomer) {
			conditions.push("ATIVO = ?");
			bindings.push(filters.activeCustomer);
		}

		const searchTerm = filters.searchTerm?.trim();
		if (searchTerm) {
			const likeTerm = `%${searchTerm}%`;
			conditions.push("(RAZAO LIKE ? OR FANTASIA LIKE ? OR CPF_CNPJ LIKE ? OR COD_ERP LIKE ? OR CIDADE LIKE ?)");
			bindings.push(likeTerm, likeTerm, likeTerm, likeTerm, likeTerm);
		}

		const pushNumericFilter = (column: string, values: number[] | undefined) => {
			if (!values?.length) {
				return;
			}

			const placeholders = values.map(() => "?").join(", ");
			conditions.push(`${column} IN (${placeholders})`);
			bindings.push(...values);
		};

		pushNumericFilter("SEGMENTO", filters.segmentIds);
		pushNumericFilter("COD_CAMPANHA", filters.campaignIds);
		pushNumericFilter("OPERADOR", filters.operatorIds);

		if (!conditions.length) {
			return null;
		}

		const rows = await instancesService.executeQuery<CustomerIdRow[]>(
			instance,
			[
				"SELECT CODIGO",
				"FROM clientes",
				`WHERE ${conditions.join(" AND ")}`,
				"ORDER BY CODIGO ASC",
			].join(" "),
			bindings,
		);

		return rows.map((row) => Number(row.CODIGO)).filter((customerId) => Number.isInteger(customerId) && customerId > 0);
	}

	private async collectInteractionMetrics(instance: string, customerId: number): Promise<Omit<CustomerInteractionTagMetrics, "reasons">> {
		const contacts = await prismaService.wppContact.findMany({
			where: {
				instance,
				customerId,
				isDeleted: false,
			},
			select: {
				id: true,
			},
		});

		const contactIds = contacts.map((contact) => contact.id);
		if (!contactIds.length) {
			return {
				windowDays: INTERACTION_WINDOW_DAYS,
				contactCount: 0,
				chatCount90d: 0,
				messageCount90d: 0,
				recentActiveDays90d: 0,
				lastInteractionAt: null,
				allTimeMessageCount: 0,
				allTimeChatCount: 0,
				activeContactCount: 0,
			};
		}

		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - INTERACTION_WINDOW_DAYS);

		const [recentMessagesAggregate, allTimeMessagesAggregate, recentChatsCount, allTimeChatsCount, recentInteractionAggregate] = await Promise.all([
			prismaService.wppMessage.aggregate({
				where: {
					instance,
					contactId: { in: contactIds },
					sentAt: { gte: cutoffDate },
				},
				_count: {
					id: true,
				},
				_max: {
					sentAt: true,
				},
			}),
			prismaService.wppMessage.aggregate({
				where: {
					instance,
					contactId: { in: contactIds },
				},
				_count: {
					id: true,
				},
				_max: {
					sentAt: true,
				},
			}),
			prismaService.wppChat.count({
				where: {
					instance,
					contactId: { in: contactIds },
					OR: [
						{ startedAt: { gte: cutoffDate } },
						{ messages: { some: { sentAt: { gte: cutoffDate } } } },
					],
				},
			}),
			prismaService.wppChat.count({
				where: {
					instance,
					contactId: { in: contactIds },
				},
			}),
			prismaService.$queryRaw<RecentInteractionAggregateRow[]>(Prisma.sql`
				SELECT
					COUNT(DISTINCT DATE(sent_at)) AS activeDays,
					COUNT(DISTINCT contact_id) AS activeContacts
				FROM messages
				WHERE instance = ${instance}
					AND contact_id IN (${Prisma.join(contactIds)})
					AND sent_at >= ${cutoffDate}
			`),
		]);

		const lastInteractionAt = allTimeMessagesAggregate._max.sentAt?.toISOString() ?? null;
		const activityAggregate = recentInteractionAggregate[0];
		const recentActiveDays90d = Number(activityAggregate?.activeDays ?? 0);
		const activeContactCount = Number(activityAggregate?.activeContacts ?? 0);

		return {
			windowDays: INTERACTION_WINDOW_DAYS,
			contactCount: contactIds.length,
			chatCount90d: recentChatsCount,
			messageCount90d: recentMessagesAggregate._count.id,
			recentActiveDays90d,
			lastInteractionAt,
			allTimeMessageCount: allTimeMessagesAggregate._count.id,
			allTimeChatCount: allTimeChatsCount,
			activeContactCount,
		};
	}

	private async collectPurchaseMetrics(instance: string, customerId: number): Promise<Omit<CustomerPurchaseTagMetrics, "reasons">> {
		const cutoffDate = new Date();
		cutoffDate.setMonth(cutoffDate.getMonth() - PURCHASE_WINDOW_MONTHS);

		const [aggregate] = await instancesService.executeQuery<PurchaseAggregateRow[]>(
			instance,
			[
				"SELECT",
				"COUNT(*) AS allTimePurchaseCount,",
				"SUM(CASE WHEN DATA >= ? THEN 1 ELSE 0 END) AS purchaseCount12m,",
				"SUM(CASE WHEN DATA >= ? THEN COALESCE(VALOR, 0) ELSE 0 END) AS totalPurchaseValue12m,",
				"MAX(DATA) AS lastPurchaseAt",
				"FROM compras",
				"WHERE CLIENTE = ?",
			].join(" "),
			[cutoffDate, cutoffDate, customerId]
		);

		const allTimePurchaseCount = Number(aggregate?.allTimePurchaseCount ?? 0);
		const purchaseCount12m = Number(aggregate?.purchaseCount12m ?? 0);
		const totalPurchaseValue12m = Number(aggregate?.totalPurchaseValue12m ?? 0);
		const lastPurchaseAt = aggregate?.lastPurchaseAt
			? new Date(aggregate.lastPurchaseAt).toISOString()
			: null;
		const daysSinceLastPurchase = lastPurchaseAt
			? Math.max(0, Math.floor((Date.now() - new Date(lastPurchaseAt).getTime()) / 86400000))
			: null;

		return {
			windowMonths: PURCHASE_WINDOW_MONTHS,
			allTimePurchaseCount,
			purchaseCount12m,
			totalPurchaseValue12m,
			lastPurchaseAt,
			daysSinceLastPurchase,
		};
	}

	private async collectCustomerAgeMetrics(instance: string, customerId: number): Promise<Omit<CustomerAgeTagMetrics, "reasons">> {
		const [customer] = await instancesService.executeQuery<CustomerRegistrationRow[]>(
			instance,
			["SELECT DATACAD AS registeredAt", "FROM clientes", "WHERE CODIGO = ?", "LIMIT 1"].join(" "),
			[customerId]
		);

		if (!customer?.registeredAt) {
			return {
				newCustomerWindowDays: NEW_CUSTOMER_WINDOW_DAYS,
				registeredAt: null,
				customerAgeDays: null,
				customerAgeMonths: null,
			};
		}

		const registeredAtDate = new Date(customer.registeredAt);
		if (Number.isNaN(registeredAtDate.getTime())) {
			return {
				newCustomerWindowDays: NEW_CUSTOMER_WINDOW_DAYS,
				registeredAt: null,
				customerAgeDays: null,
				customerAgeMonths: null,
			};
		}

		const now = new Date();
		const customerAgeDays = Math.max(0, Math.floor((now.getTime() - registeredAtDate.getTime()) / 86400000));
		const customerAgeMonths = this.calculateMonthDiff(registeredAtDate, now);

		return {
			newCustomerWindowDays: NEW_CUSTOMER_WINDOW_DAYS,
			registeredAt: registeredAtDate.toISOString(),
			customerAgeDays,
			customerAgeMonths,
		};
	}

	public async getInteractionTag(
		instance: string,
		customerId: number
	): Promise<CustomerProfileTagPayload<CustomerInteractionTagMetrics> | null> {
		const snapshot = await prismaService.customerProfileTag.findUnique({
			where: {
				instance_customerId_tagType: {
					instance,
					customerId,
					tagType: "INTERACTION_LEVEL",
				},
			},
		});

		return snapshot ? (this.normalizePayload(snapshot) as CustomerProfileTagPayload<CustomerInteractionTagMetrics>) : null;
	}

	public async getPurchaseTag(
		instance: string,
		customerId: number
	): Promise<CustomerProfileTagPayload<CustomerPurchaseTagMetrics> | null> {
		const snapshot = await prismaService.customerProfileTag.findUnique({
			where: {
				instance_customerId_tagType: {
					instance,
					customerId,
					tagType: "PURCHASE_LEVEL",
				},
			},
		});

		return snapshot ? (this.normalizePayload(snapshot) as CustomerProfileTagPayload<CustomerPurchaseTagMetrics>) : null;
	}

	public async getCustomerAgeTag(
		instance: string,
		customerId: number
	): Promise<CustomerProfileTagPayload<CustomerAgeTagMetrics> | null> {
		const snapshot = await prismaService.customerProfileTag.findUnique({
			where: {
				instance_customerId_tagType: {
					instance,
					customerId,
					tagType: "CUSTOMER_AGE",
				},
			},
		});

		return snapshot ? (this.normalizePayload(snapshot) as CustomerProfileTagPayload<CustomerAgeTagMetrics>) : null;
	}

	public async getOrCreateInteractionTag(
		instance: string,
		customerId: number
	): Promise<CustomerProfileTagPayload<CustomerInteractionTagMetrics>> {
		const existing = await this.getInteractionTag(instance, customerId);
		if (existing && !this.shouldRefreshInteractionSnapshot(existing)) {
			return existing;
		}

		return this.rebuildInteractionTag(instance, customerId);
	}

	public async rebuildInteractionTag(
		instance: string,
		customerId: number
	): Promise<CustomerProfileTagPayload<CustomerInteractionTagMetrics>> {
		const baseMetrics = await this.collectInteractionMetrics(instance, customerId);
		const metrics: CustomerInteractionTagMetrics = {
			...baseMetrics,
			reasons: this.buildInteractionReasons(baseMetrics),
		};
		const metadataJson = metrics as unknown as Prisma.InputJsonValue;
		const tagValue = this.resolveInteractionLevel(baseMetrics);
		const tagConfig = INTERACTION_TAG_CONFIG[tagValue];

		const snapshot = await prismaService.customerProfileTag.upsert({
			where: {
				instance_customerId_tagType: {
					instance,
					customerId,
					tagType: "INTERACTION_LEVEL",
				},
			},
			create: {
				instance,
				customerId,
				tagType: CustomerProfileTagType.INTERACTION_LEVEL,
				tagValue,
				label: tagConfig.label,
				color: tagConfig.color,
				calculatedAt: new Date(),
				metadataJson,
			},
			update: {
				tagValue,
				label: tagConfig.label,
				color: tagConfig.color,
				calculatedAt: new Date(),
				metadataJson,
			},
		});

		return this.normalizePayload(snapshot) as CustomerProfileTagPayload<CustomerInteractionTagMetrics>;
	}

	public async getOrCreatePurchaseTag(
		instance: string,
		customerId: number
	): Promise<CustomerProfileTagPayload<CustomerPurchaseTagMetrics>> {
		const existing = await this.getPurchaseTag(instance, customerId);
		if (existing) {
			return existing;
		}

		return this.rebuildPurchaseTag(instance, customerId);
	}

	public async getOrCreateCustomerAgeTag(
		instance: string,
		customerId: number
	): Promise<CustomerProfileTagPayload<CustomerAgeTagMetrics>> {
		const existing = await this.getCustomerAgeTag(instance, customerId);
		if (existing && !this.shouldRefreshCustomerAgeSnapshot(existing)) {
			return existing;
		}

		return this.rebuildCustomerAgeTag(instance, customerId);
	}

	public async getCustomerProfileSummary(instance: string, customerId: number): Promise<CustomerProfileSummaryPayload> {
		const [interactionTag, purchaseTag, ageTag] = await Promise.all([
			this.getOrCreateInteractionTag(instance, customerId),
			this.getOrCreatePurchaseTag(instance, customerId),
			this.getOrCreateCustomerAgeTag(instance, customerId),
		]);

		return this.buildResolvedProfileSummary(
			instance,
			customerId,
			interactionTag as CustomerProfileTagPayload<CustomerInteractionTagMetrics>,
			purchaseTag as CustomerProfileTagPayload<CustomerPurchaseTagMetrics>,
			ageTag as CustomerProfileTagPayload<CustomerAgeTagMetrics>
		);
	}

	public async getCustomerProfileManualOverrides(
		instance: string,
		customerId: number
	): Promise<CustomerProfileManualOverrides | null> {
		const purchaseTag = await this.getOrCreatePurchaseTag(instance, customerId);
		return this.extractManualOverrides(purchaseTag.metadata);
	}

	public async updateCustomerProfileManualOverrides(
		instance: string,
		customerId: number,
		input: UpdateCustomerProfileManualOverridesInput,
		updatedBy: { userId: number; name: string }
	): Promise<CustomerProfileSummaryPayload> {
		await this.getOrCreatePurchaseTag(instance, customerId);

		const snapshot = await prismaService.customerProfileTag.findUnique({
			where: {
				instance_customerId_tagType: {
					instance,
					customerId,
					tagType: "PURCHASE_LEVEL",
				},
			},
		});

		if (!snapshot) {
			return this.getCustomerProfileSummary(instance, customerId);
		}

		const normalizedSnapshot = this.normalizePayload(snapshot) as CustomerProfileTagPayload<CustomerPurchaseTagMetrics>;
		const currentManualOverrides = this.extractManualOverrides(normalizedSnapshot.metadata);
		const nextManualOverrides: CustomerProfileManualOverrides | null = {
			profileLevel:
				input.profileLevel !== undefined
					? input.profileLevel
					: currentManualOverrides?.profileLevel ?? null,
			purchaseInterestLevel:
				input.purchaseInterestLevel !== undefined
					? input.purchaseInterestLevel
					: currentManualOverrides?.purchaseInterestLevel ?? null,
			updatedAt: new Date().toISOString(),
			updatedByUserId: updatedBy.userId,
			updatedByName: updatedBy.name,
		};

		const hasAnyOverride = Boolean(
			nextManualOverrides.profileLevel || nextManualOverrides.purchaseInterestLevel
		);

		const baseMetrics = this.stripManualOverrides(normalizedSnapshot.metadata);
		await prismaService.customerProfileTag.update({
			where: {
				instance_customerId_tagType: {
					instance,
					customerId,
					tagType: CustomerProfileTagType.PURCHASE_LEVEL,
				},
			},
			data: {
				metadataJson: this.mergePurchaseMetadataWithManualOverrides(
					baseMetrics,
					hasAnyOverride ? nextManualOverrides : null
				),
			},
		});

		return this.getCustomerProfileSummary(instance, customerId);
	}

	public async getCustomerProfileSummaries(
		instance: string,
		customerIds: number[]
	): Promise<CustomerProfileSummaryPayload[]> {
		const uniqueCustomerIds = Array.from(
			new Set(
				customerIds.filter((customerId) => Number.isInteger(customerId) && customerId > 0)
			)
		);

		if (!uniqueCustomerIds.length) {
			return [];
		}

		return Promise.all(
			uniqueCustomerIds.map((customerId) => this.getCustomerProfileSummary(instance, customerId))
		);
	}

	public async findCustomerIdsByProfileFilters(
		instance: string,
		filters: CustomerProfileSummaryFilters
	): Promise<number[]> {
		const baseFilteredCustomerIds = await this.listCustomerIdsByBaseFilters(instance, filters);
		const hasComputedFilters = this.hasComputedSummaryFilters(filters);

		if (!hasComputedFilters && filters.purchaseInterestLevel === "nao_analisado") {
			return baseFilteredCustomerIds ?? this.listAllCustomerIds(instance);
		}

		if (!hasComputedFilters) {
			return baseFilteredCustomerIds ?? [];
		}

		const allCustomerIds = baseFilteredCustomerIds ?? await this.listAllCustomerIds(instance);
		if (!allCustomerIds.length) {
			return [];
		}

		const snapshots = await prismaService.customerProfileTag.findMany({
			where: {
				instance,
				customerId: {
					in: allCustomerIds,
				},
				tagType: {
					in: [
						CustomerProfileTagType.INTERACTION_LEVEL,
						CustomerProfileTagType.PURCHASE_LEVEL,
						CustomerProfileTagType.CUSTOMER_AGE,
					],
				},
			},
			orderBy: [{ customerId: "asc" }, { tagType: "asc" }],
		});

		const groupedSnapshots = new Map<
			number,
			{
				interaction?: CustomerProfileTagPayload<CustomerInteractionTagMetrics>;
				purchase?: CustomerProfileTagPayload<CustomerPurchaseTagMetrics>;
				age?: CustomerProfileTagPayload<CustomerAgeTagMetrics>;
			}
		>();

		for (const snapshot of snapshots) {
			const current = groupedSnapshots.get(snapshot.customerId) ?? {};
			const normalizedSnapshot = this.normalizePayload(snapshot);

			if (snapshot.tagType === CustomerProfileTagType.INTERACTION_LEVEL) {
				current.interaction = normalizedSnapshot as CustomerProfileTagPayload<CustomerInteractionTagMetrics>;
			} else if (snapshot.tagType === CustomerProfileTagType.PURCHASE_LEVEL) {
				current.purchase = normalizedSnapshot as CustomerProfileTagPayload<CustomerPurchaseTagMetrics>;
			} else if (snapshot.tagType === CustomerProfileTagType.CUSTOMER_AGE) {
				current.age = normalizedSnapshot as CustomerProfileTagPayload<CustomerAgeTagMetrics>;
			}

			groupedSnapshots.set(snapshot.customerId, current);
		}

		const missingCustomerIds = allCustomerIds.filter((customerId) => !groupedSnapshots.has(customerId));

		for (const customerIdsChunk of this.chunkNumbers(missingCustomerIds, this.profileSummaryBatchSize)) {
			const summaries = await this.getCustomerProfileSummaries(instance, customerIdsChunk);

			for (const summary of summaries) {
				groupedSnapshots.set(summary.customerId, {
					interaction: summary.tags.interaction,
					purchase: summary.tags.purchase,
					age: summary.tags.age,
				});
			}
		}

		return allCustomerIds.filter((customerId) => {
			const tags = groupedSnapshots.get(customerId) ?? {};
			return this.matchesSummaryFilters(tags, filters);
		});
	}

	public async rebuildPurchaseTag(
		instance: string,
		customerId: number
	): Promise<CustomerProfileTagPayload<CustomerPurchaseTagMetrics>> {
		const existing = await this.getPurchaseTag(instance, customerId);
		const manualOverrides = this.extractManualOverrides(existing?.metadata ?? null);
		const baseMetrics = await this.collectPurchaseMetrics(instance, customerId);
		const metrics: CustomerPurchaseTagMetrics = {
			...baseMetrics,
			reasons: this.buildPurchaseReasons(baseMetrics),
		};
		const metadataJson = this.mergePurchaseMetadataWithManualOverrides(metrics, manualOverrides);
		const tagValue = this.resolvePurchaseLevel(baseMetrics);
		const tagConfig = PURCHASE_TAG_CONFIG[tagValue];

		const snapshot = await prismaService.customerProfileTag.upsert({
			where: {
				instance_customerId_tagType: {
					instance,
					customerId,
					tagType: "PURCHASE_LEVEL",
				},
			},
			create: {
				instance,
				customerId,
				tagType: CustomerProfileTagType.PURCHASE_LEVEL,
				tagValue,
				label: tagConfig.label,
				color: tagConfig.color,
				calculatedAt: new Date(),
				metadataJson,
			},
			update: {
				tagValue,
				label: tagConfig.label,
				color: tagConfig.color,
				calculatedAt: new Date(),
				metadataJson,
			},
		});

		return this.normalizePayload(snapshot) as CustomerProfileTagPayload<CustomerPurchaseTagMetrics>;
	}

	public async rebuildCustomerAgeTag(
		instance: string,
		customerId: number
	): Promise<CustomerProfileTagPayload<CustomerAgeTagMetrics>> {
		const baseMetrics = await this.collectCustomerAgeMetrics(instance, customerId);
		const metrics: CustomerAgeTagMetrics = {
			...baseMetrics,
			reasons: this.buildCustomerAgeReasons(baseMetrics),
		};
		const metadataJson = metrics as unknown as Prisma.InputJsonValue;
		const tagValue = this.resolveCustomerAgeLevel(baseMetrics);
		const tagConfig = AGE_TAG_CONFIG[tagValue];

		const snapshot = await prismaService.customerProfileTag.upsert({
			where: {
				instance_customerId_tagType: {
					instance,
					customerId,
					tagType: "CUSTOMER_AGE",
				},
			},
			create: {
				instance,
				customerId,
				tagType: CustomerProfileTagType.CUSTOMER_AGE,
				tagValue,
				label: tagConfig.label,
				color: tagConfig.color,
				calculatedAt: new Date(),
				metadataJson,
			},
			update: {
				tagValue,
				label: tagConfig.label,
				color: tagConfig.color,
				calculatedAt: new Date(),
				metadataJson,
			},
		});

		return this.normalizePayload(snapshot) as CustomerProfileTagPayload<CustomerAgeTagMetrics>;
	}

	public async rebuildInteractionTagsForInstance(instance: string): Promise<{
		rebuiltCount: number;
		customerIds: number[];
	}> {
		const contacts = await prismaService.wppContact.findMany({
			where: {
				instance,
				isDeleted: false,
				customerId: { not: null },
			},
			select: {
				customerId: true,
			},
			distinct: ["customerId"],
		});

		const customerIds = contacts
			.map((contact) => contact.customerId)
			.filter((customerId): customerId is number => typeof customerId === "number");

		for (const customerId of customerIds) {
			await this.rebuildInteractionTag(instance, customerId);
		}

		return {
			rebuiltCount: customerIds.length,
			customerIds,
		};
	}

	public async rebuildPurchaseTagsForInstance(instance: string): Promise<{
		rebuiltCount: number;
		customerIds: number[];
	}> {
		const contacts = await prismaService.wppContact.findMany({
			where: {
				instance,
				isDeleted: false,
				customerId: { not: null },
			},
			select: {
				customerId: true,
			},
			distinct: ["customerId"],
		});

		const customerIds = contacts
			.map((contact) => contact.customerId)
			.filter((customerId): customerId is number => typeof customerId === "number");

		for (const customerId of customerIds) {
			await this.rebuildPurchaseTag(instance, customerId);
		}

		return {
			rebuiltCount: customerIds.length,
			customerIds,
		};
	}

	public async rebuildCustomerAgeTagsForInstance(instance: string): Promise<{
		rebuiltCount: number;
		customerIds: number[];
	}> {
		const contacts = await prismaService.wppContact.findMany({
			where: {
				instance,
				isDeleted: false,
				customerId: { not: null },
			},
			select: {
				customerId: true,
			},
			distinct: ["customerId"],
		});

		const customerIds = contacts
			.map((contact) => contact.customerId)
			.filter((customerId): customerId is number => typeof customerId === "number");

		for (const customerId of customerIds) {
			await this.rebuildCustomerAgeTag(instance, customerId);
		}

		return {
			rebuiltCount: customerIds.length,
			customerIds,
		};
	}
}

export default new CustomerProfileTagsService();