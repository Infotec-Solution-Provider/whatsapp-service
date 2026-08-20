import { Customer } from "./customers.types";

export interface WppContact {
	id: number;
	name: string;
	phone: string;
	customerId?: number;
	avatarUrl?: string;
	instance: string;
	isBlocked: boolean;
	isOnlyAdmin: boolean;
	lastOutOfHoursReplySentAt?: Date | null;
	sectors?: {
		contactId: number;
		sectorId: number;
	}[];
	sectorIds?: number[];
}export interface WppContactWithCustomer {
	id: number;
	name: string;
	phone: string;
	customerId: number | null;
	avatarUrl: string | null;
	instance: string;
	isBlocked: boolean;
	isOnlyAdmin: boolean;
	isDeleted: boolean;
	createdAt: Date;
	updatedAt: Date | null;
	conversationExpiration: string | null;
	customer: Customer | null;
	chatingWith: string | null;
	lastOutOfHoursReplySentAt: Date | null;
	sectorIds: number[];
}

export interface PaginatedContactsResponse {
	data: WppContactWithCustomer[];
	pagination: {
		page: number;
		perPage: number;
		total: number;
		totalPages: number;
		hasNext: boolean;
		hasPrev: boolean;
	};
}

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

export type CustomerProfileSummaryLevel =
	| "potencial_de_compra"
	| "consolidado"
	| "precisa_mais_interacao"
	| "em_observacao";

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

export interface CustomerProfileSummaryBatchRequest {
	customerIds: number[];
}

export interface WppMessage {
	id: number;
	instance: string;
	wwebjsId: string | null;
	wabaId: string | null;
	gupshupId: string | null;
	gupshupRequestId: string | null;
	from: string;
	to: string;
	type: string;
	quotedId: number | null;
	chatId: number | null;
	contactId: number | null;
	body: string;
	timestamp: string;
	status: WppMessageStatus;
	isForwarded: boolean;
	isEdited: boolean;
	fileId: number | null;
	fileName: string | null;
	fileType: string | null;
	fileSize: string | null;
	wwebjsIdStanza: string | null;
	sentAt: Date;
	userId: number | null;
	agentId: number | null;
	billingCategory: string | null;
	clientId: number | null;
}
export interface ForwardMessagesData {
	sourceType: "whatsapp" | "internal";
	messageIds: number[];
	whatsappTargets?: Array<{ id: string; isGroup: boolean }>;
	internalTargets?: Array<{ id: number }>;
}

export interface WppChat {
	id: number;
	instance: string;
	contactId?: number;
	userId?: number;
	userName?: string;
	walletId?: number;
	botId?: number;
	agentId?: number | null;
	resultId?: number;
	sectorId?: number;
	type: WppChatType;
	priority: WppChatPriority;
	avatarUrl?: string;
	isFinished: boolean;
	startedAt: Date;
	finishedAt?: Date | null;
	finishedBy?: number | null;
	isSchedule: boolean;
}

export interface WppSector {
	id: number;
	name: string;
	instanceName: string;
	wppInstanceId?: number;
	startChats: boolean;
	receiveChats: boolean;
}

export interface WppWallet {
	instance: string;
	id: number;
	name: string;
	userIds: number[];
}

// Enums
export type WppMessageStatus =
	| "PENDING"
	| "SENT"
	| "RECEIVED"
	| "READ"
	| "DOWNLOADED"
	| "ERROR"
	| "REVOKED";

export enum WppChatType {
	RECEPTIVE = "RECEPTIVE",
	ACTIVE = "ACTIVE",
}

export enum WppChatPriority {
	LOW = "LOW",
	NORMAL = "NORMAL",
	HIGH = "HIGH",
	VERY_HIGH = "VERY_HIGH",
	URGENCY = "URGENCY",
}

export type WppChatWithDetails = WppChat & {
	contact: WppContact | null;
	customer: Customer | null;
	schedule: WppSchedule | null;
};
export type WppChatsAndMessages = {
	chats: WppChatWithDetails[];
	messages: WppMessage[];
};
export type WppChatWithDetailsAndMessages = WppChatWithDetails & {
	messages: WppMessage[];
};

export interface SendMessageData {
	text: string;
	contactId: number;
	chatId?: number | null;
	quotedId?: number | null;
	isForwarded?: boolean;
	sendAsChatOwner?: boolean;
	sendAsAudio?: boolean;
	sendAsDocument?: boolean;
	fileId?: number;
	traceId?: string;
	readyMessageId?: number;
}

export interface SendFileMessageData extends SendMessageData {
	fileId: number;
	sendAsDocument: boolean;
	sendAsAudio: boolean;
}

export interface MonitorChat {
	id: string;
	erpCode: string;
	companyName: string;
	contactName: string;
	whatsappNumber: string;
	sectorName: string;
	attendantName: string;
	startDate: string;
	endDate: string;
	result: string;
}

export interface CreateScheduleDTO {
	contactId: number;
	date: Date;
	scheduledFor: number;
	sectorId: number;
}

export type UnifiedScheduleChannel = "WHATSAPP" | "TELEFONIA";

export type UnifiedScheduleRepurchaseStatus = "green" | "yellow" | "red" | "neutral";

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

export interface UnifiedScheduleFilters extends CustomerProfileSummaryFilters {
	page?: string;
	perPage?: string;
	channels?: string;
	customerCampaignIds?: string;
	repurchaseStatuses?: string;
	userId?: string;
	sectorId?: string;
}

export interface UnifiedSchedule {
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
	data: UnifiedSchedule[];
	page: {
		current: number;
		totalRows: number;
	};
	pagination: UnifiedSchedulePagination;
	filters: UnifiedScheduleFilterMetadata;
}

export interface WppSchedule {
	id: number;
	instance: string;
	sectorId: number;
	description: string | null;
	contactId: number;
	scheduleDate: string;
	scheduledBy: number;
	scheduledFor: number;
	scheduledAt: string;
	chatId: number | null;
	contact: WppContact;
}
export type NotificationType =
	| "CHAT_AUTO_FINISHED"
	| "CHAT_TRANSFERRED"
	| "CHAT_REASSIGNED"
	| "ALERT"
	| "INFO"
	| "WARNING"
	| "ERROR";

export interface AppNotification {
	id: number;
	title: string;
	description: string;
	read: boolean;
	instance: string;
	userId: number | null;
	chatId: number | null;
	type: NotificationType;
	createdAt: string;
}

export interface PaginatedNotificationsResponse {
	notifications: AppNotification[];
	totalCount: number;
}
export type Frequency = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface AutomaticResponseSchedule {
	id?: number;

	frequency: Frequency;
	daysOfWeek?: number[] | null;
	dayOfMonth?: number | null;
	month?: number | null;

	startDate?: string | null;
	endDate?: string | null;

	startTime: string;
	endTime: string;
	timezone?: string | null;

	dayOfWeek?: number | null;
}

export interface AutomaticResponseRule {
	id: number;
	name: string;
	message: string;
	isEnabled: boolean;
	isGlobal: boolean;
	cooldownSeconds: number;
	fileId: number | null;
	schedules: AutomaticResponseSchedule[];
	userAssignments: { userId: number }[];
}

export interface AutomaticResponseRuleDTO {
	name: string;
	message: string;
	isEnabled: boolean;
	isGlobal: boolean;
	cooldownSeconds: number;
	fileId?: number | null;
	userIds: number[];
	schedules: Omit<AutomaticResponseSchedule, "id">[];
}
