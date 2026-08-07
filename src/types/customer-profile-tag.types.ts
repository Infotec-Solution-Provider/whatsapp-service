export const INTERACTION_TAG_TYPE = "interaction_level" as const;
export const PURCHASE_TAG_TYPE = "purchase_level" as const;
export const AGE_TAG_TYPE = "customer_age" as const;

export type CustomerInteractionLevel =
	| "sem_interacao"
	| "pouca_interacao"
	| "interacao_media"
	| "interacao_alta";

export type CustomerPurchaseLevel =
	| "sem_compras"
	| "poucas_compras"
	| "compras_medias"
	| "muitas_compras";

export type CustomerAgeLevel =
	| "sem_data_cadastro"
	| "cliente_novo"
	| "ate_6_meses"
	| "ate_12_meses"
	| "mais_de_12_meses";

export type CustomerPurchaseInterestLevel =
	| "nao_analisado"
	| "baixo_interesse"
	| "interesse_moderado"
	| "alto_interesse"
	| "pronto_para_compra";

export interface CustomerProfileManualOverrides {
	profileLevel: CustomerProfileSummaryLevel | null;
	purchaseInterestLevel: CustomerPurchaseInterestLevel | null;
	updatedAt: string;
	updatedByUserId: number;
	updatedByName: string;
}

export interface UpdateCustomerProfileManualOverridesInput {
	profileLevel?: CustomerProfileSummaryLevel | null;
	purchaseInterestLevel?: CustomerPurchaseInterestLevel | null;
}

export interface CustomerPurchaseInterestPayload {
	level: CustomerPurchaseInterestLevel;
	label: string;
	color: string;
	reasons: string[];
	source: "placeholder_rules" | "manual_override";
}

export interface CustomerInteractionTagMetrics {
	windowDays: number;
	contactCount: number;
	chatCount90d: number;
	messageCount90d: number;
	recentActiveDays90d: number;
	lastInteractionAt: string | null;
	allTimeMessageCount: number;
	allTimeChatCount: number;
	activeContactCount: number;
	reasons: string[];
}

export interface CustomerPurchaseTagMetrics {
	windowMonths: number;
	allTimePurchaseCount: number;
	purchaseCount12m: number;
	totalPurchaseValue12m: number;
	lastPurchaseAt: string | null;
	daysSinceLastPurchase: number | null;
	reasons: string[];
}

export interface CustomerAgeTagMetrics {
	newCustomerWindowDays: number;
	registeredAt: string | null;
	customerAgeDays: number | null;
	customerAgeMonths: number | null;
	reasons: string[];
}

export type CustomerProfileTagMetadata =
	| CustomerInteractionTagMetrics
	| CustomerPurchaseTagMetrics
	| CustomerAgeTagMetrics;

export type CustomerProfileSummaryLevel =
	| "potencial_de_compra"
	| "consolidado"
	| "precisa_mais_interacao"
	| "em_observacao";

export interface CustomerProfileSummaryPayload {
	instance: string;
	customerId: number;
	profileLevel: CustomerProfileSummaryLevel;
	label: string;
	color: string;
	profileSource: "automatic" | "manual_override";
	reasons: string[];
	purchaseInterest: CustomerPurchaseInterestPayload;
	manualOverrides: CustomerProfileManualOverrides | null;
	tags: {
		interaction: CustomerProfileTagPayload<CustomerInteractionTagMetrics>;
		purchase: CustomerProfileTagPayload<CustomerPurchaseTagMetrics>;
		age: CustomerProfileTagPayload<CustomerAgeTagMetrics>;
	};
}

export interface CustomerProfileTagPayload<TMetadata = CustomerProfileTagMetadata> {
	id: number;
	instance: string;
	customerId: number;
	tagType: string;
	tagValue: string;
	label: string;
	color: string;
	calculatedAt: string;
	metadata: TMetadata | null;
}

export interface CustomerProfileSummaryFilters {
	profileLevel?: CustomerProfileSummaryLevel;
	interactionLevel?: CustomerInteractionLevel;
	purchaseLevel?: CustomerPurchaseLevel;
	ageLevel?: CustomerAgeLevel;
	purchaseInterestLevel?: CustomerPurchaseInterestLevel;
	state?: string;
	city?: string;
	activeCustomer?: "SIM" | "NAO";
	searchTerm?: string;
	segmentIds?: number[];
	campaignIds?: number[];
	operatorIds?: number[];
}