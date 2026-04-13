import {
	CustomerProfileSummaryFilters,
	CustomerProfileSummaryPayload,
} from "@in.pulse-crm/sdk";

export type UnifiedScheduleChannel = "WHATSAPP" | "TELEFONIA";

export type UnifiedScheduleRepurchaseStatus = "green" | "yellow" | "red" | "neutral";

export interface UnifiedScheduleFilters extends CustomerProfileSummaryFilters {
	page?: string;
	perPage?: string;
	channels?: string;
	customerCampaignIds?: string;
	repurchaseStatuses?: string;
	userId?: string;
	sectorId?: string;
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
}