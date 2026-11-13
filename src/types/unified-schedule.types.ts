import {
	CustomerProfileSummaryFilters,
	CustomerProfileSummaryPayload,
} from "../sdk-local";

export type UnifiedScheduleChannel = "WHATSAPP" | "TELEFONIA";

export type UnifiedScheduleRepurchaseStatus = "green" | "yellow" | "red" | "neutral";

export interface UnifiedScheduleFilters extends Omit<CustomerProfileSummaryFilters, "segmentIds"> {
	page?: string;
	perPage?: string;
	channels?: string;
	customerCampaignIds?: string;
	repurchaseStatuses?: string;
	userId?: string;
	sectorId?: string;
	search?: string;
	period?: "all" | "overdue" | "today" | "next7" | "custom";
	scheduledFrom?: string;
	scheduledTo?: string;
	sortOrder?: "asc" | "desc";
	view?: "crm";
	purchaseStatus?: "with_purchases" | "without_purchases";
	purchaseFrom?: string;
	purchaseTo?: string;
	registeredFrom?: string;
	registeredTo?: string;
	segmentIds?: string;
	loyaltyOperatorIds?: string;
	groupIds?: string;
	originIds?: string;
	mediaIds?: string;
	unitIds?: string;
	brandIds?: string;
	positionIds?: string;
	states?: string;
	phone?: string;
	email?: string;
	CODIGO?: string;
	CPF_CNPJ?: string;
	COD_ERP?: string;
	CIDADE?: string;
	ATIVO?: "SIM" | "NAO";
	PESSOA?: "FIS" | "JUR";
}

export interface UnifiedScheduleRepurchaseMetrics {
	averageRepurchaseDays: number | null;
	daysSinceLastPurchase: number | null;
	nextRepurchaseDate: string | null;
	proximityRatio: number | null;
	semaphoreStatus: UnifiedScheduleRepurchaseStatus;
	overdueDays: number | null;
}

export interface UnifiedScheduleCampaignFilterOption {
	id: string;
	label: string;
}

export interface UnifiedScheduleFilterMetadata {
	customerCampaigns: UnifiedScheduleCampaignFilterOption[];
}

export interface UnifiedSchedulePagination {
	current: number;
	perPage: number;
	totalRows: number;
	totalPages: number;
	hasNext: boolean;
	hasPrev: boolean;
}

export interface UnifiedScheduleItem {
	id: string;
	channel: UnifiedScheduleChannel;
	scheduleId: number;
	scheduleAt: string;
	scheduledBy: number | null;
	scheduledFor: number | null;
	description: string | null;
	contactName: string | null;
	contactPhone: string | null;
	customerId: number | null;
	customerName: string | null;
	customerFantasyName: string | null;
	customerCampaignId: number | null;
	customerCampaignName: string | null;
	customerOriginId: number | null;
	customerOriginDescription: string | null;
	telephonyCampaignId: number | null;
	telephonyCampaignName: string | null;
	profileSummary: CustomerProfileSummaryPayload | null;
	repurchase: UnifiedScheduleRepurchaseMetrics | null;
	meta: {
		wppContactId?: number;
		wppChatId?: number | null;
		telephonyRecordId?: number;
		commercialRestricted?: boolean;
		enrichmentUnavailable?: boolean;
	};
}

export interface UnifiedSchedulesResponse {
	message: string;
	data: UnifiedScheduleItem[];
	page: {
		current: number;
		totalRows: number;
	};
	pagination: UnifiedSchedulePagination;
	filters: UnifiedScheduleFilterMetadata;
	referenceAt?: string;
	timeZone?: string;
	warnings?: Array<{ code: string; message: string }>;
	capabilities?: { channels: UnifiedScheduleChannel[]; commercial: boolean };
}
