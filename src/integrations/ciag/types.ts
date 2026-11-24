export type DeliveryStatus = "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "unknown" | "cancelled";
export type ConsentStatus = "unknown" | "granted" | "revoked";
export interface WhatsAppMedia {
	id: number;
	name: string;
	mime: string;
	size: number;
	voice?: boolean;
}
export interface WhatsAppTemplate {
	id: string;
	name: string;
	language: string;
	status: string;
	body: string;
	components: Array<{
		type: string;
		format?: string;
		text?: string;
		buttons?: Array<{ type: string; text: string; url?: string }>;
	}>;
}
export interface WhatsAppContent {
	kind: "text" | "media" | "template";
	text?: string;
	media?: WhatsAppMedia;
	template?: { id: string; name: string; language: string; variables: Record<string, string>; media?: WhatsAppMedia };
}
export interface WhatsAppContact {
	id: number;
	phone: string;
	name: string;
	blocked: boolean;
	consent: ConsentStatus;
	lastInboundAt: string | null;
	lastMessageAt: string | null;
	unread: number;
	lastMessage?: string;
}
export interface WhatsAppContactLink {
	phone: string;
	userId: string;
	contactId: number;
	consent: ConsentStatus;
	consentEvidence?: string;
	updatedAt: string;
}
export interface WhatsAppClientContact {
	userId: string;
	name: string;
	company: string;
	companyId: string;
	status: string;
	phone: string | null;
	ambiguous: boolean;
	linked: boolean;
	remote?: WhatsAppContact;
}
export interface WhatsAppMessage {
	id: number;
	externalId?: string;
	phone: string;
	direction: "in" | "out" | "system";
	text: string;
	sentAt: string;
	status: DeliveryStatus;
	media?: WhatsAppMedia;
	actor?: { id: string; name: string };
	error?: string;
}
export interface WhatsAppMessagePage {
	items: WhatsAppMessage[];
	beforeId: number | null;
}
export interface BroadcastList {
	id: string;
	name: string;
	userIds: string[];
	updatedAt: string;
}
export interface BroadcastCampaign {
	id: string;
	name: string;
	content: WhatsAppContent;
	scheduledAt: string | null;
	actor: { id: string; name: string };
	createdAt: string;
	cancelled: boolean;
}
export interface BroadcastRecipient {
	id: string;
	campaignId: string;
	userId: string;
	phone: string;
	name: string;
	company: string;
	content: WhatsAppContent;
	status: DeliveryStatus;
	remoteMessageId?: number;
	error?: string;
	attempts: number;
	nextAt: number;
	updatedAt: string;
}
export interface BroadcastReview {
	recipients: Array<{
		userId: string;
		name: string;
		company: string;
		phone: string | null;
		content: WhatsAppContent;
		errors: string[];
	}>;
	reviewKey: string;
}
export interface WhatsAppSettings {
	configured: boolean;
	enabled: boolean;
	connected: boolean;
	phone?: string;
	instance?: string;
	error?: string;
}
