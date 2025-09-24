import { ReadStream } from "fs";

export type MessageType =
	| "text"
	| "reaction"
	| "image"
	| "video"
	| "audio"
	| "document"
	| "location"
	| "contacts"
	| "interactive"
	| "sticker"
	| "order"
	| "system";

export type Message =
	| WABATextMessageData
	| WABAAudioMessageData
	| WABAVideoMessageData
	| WABAImageMessageData
	| WABADocumentMessageData
	| WABAContactsMessageData
	| WABALocationMessageData
	| WABAReactionMessageData
	| WABAInteractiveMessageData
	| WABAStickerMessageData;

export type MessageStatus = "read" | "delivered" | "sent" | "failed" | "deleted";
export type ConversationCategory = "authentication" | "marketing" | "utility" | "service";
export type InteractiveMessageType = "button" | "list" | "product" | "product_list" | "flow";

export interface WABAMessageStatusData {
	id: string;
	status: MessageStatus;
	timestamp: string;
	recipient_id: string;
	conversation?: {
		id: string;
		origin?: {
			type: string;
		};
		expiration_timestamp?: string;
	};
	pricing?: {
		pricing_model: string;
		billable: boolean;
		category: ConversationCategory;
	};
	errors?: Array<{
		code: number;
		title: string;
		message: string;
		error_data?: {
			details: string;
		};
	}>;
}

export interface WABAMessageData {
	id: string;
	from: string;
	timestamp: string;
	type: MessageType;
	message_status?: MessageStatus;
	context?: {
		id: string;
		from: string;
		forwarded?: boolean;
		frequently_forwarded?: boolean;
	};
	metadata?: {
		display_phone_number: string;
		phone_number_id: string;
	};
	referral?: {
		source_url?: string;
		source_id?: string;
		source_type?: string;
		headline?: string;
		body?: string;
		media_type?: string;
		image_url?: string;
		video_url?: string;
	};
}

export interface WABATextMessageData extends WABAMessageData {
	type: "text";
	text: {
		body: string;
	};
}

export interface WABAAudioMessageData extends WABAMessageData {
	type: "audio";
	audio: {
		id: string;
		mime_type: string;
		voice: boolean;
		sha256: string;
	};
}

export interface WABAVideoMessageData extends WABAMessageData {
	type: "video";
	video: {
		id: string;
		mime_type: string;
		caption?: string;
		sha256?: string;
		filename?: string;
	};
}

export interface WABAImageMessageData extends WABAMessageData {
	type: "image";
	image: {
		id: string;
		mime_type: string;
		caption?: string;
		sha256?: string;
		filename?: string;
	};
}

export interface WABADocumentMessageData extends WABAMessageData {
	type: "document";
	document: {
		id: string;
		mime_type: string;
		filename: string;
		sha256: string;
		caption?: string;
	};
}

export interface WABAStickerMessageData extends WABAMessageData {
	type: "sticker";
	sticker: {
		id: string;
		mime_type: string;
		sha256: string;
		animated: boolean;
	};
}

export interface WABALocationMessageData extends WABAMessageData {
	type: "location";
	location: {
		latitude: number;
		longitude: number;
		name?: string;
		address?: string;
	};
}

export interface WABAReactionMessageData extends WABAMessageData {
	type: "reaction";
	reaction: {
		message_id: string;
		emoji: string;
	};
}

export interface WABAInteractiveMessageData extends WABAMessageData {
	type: "interactive";
	interactive: {
		type: InteractiveMessageType;
		button_reply?: {
			id: string;
			title: string;
		};
		list_reply?: {
			id: string;
			title: string;
			description?: string;
		};
		product_item?: {
			product_retailer_id: string;
			quantity?: number;
		};
		flow_reply?: {
			id: string;
			title: string;
			description?: string;
		};
	};
}

export interface WABAPhoneData {
	phone: string;
	type: string;
	wa_id?: string;
}

export interface WABAEmailData {
	email: string;
	type?: string;
}

export interface WABAContactData {
	name: {
		first_name: string;
		last_name?: string;
		formatted_name: string;
		middle_name?: string;
		suffix?: string;
		prefix?: string;
	};
	phones: Array<WABAPhoneData>;
	emails?: Array<WABAEmailData>;
	addresses?: Array<{
		street?: string;
		city?: string;
		state?: string;
		zip?: string;
		country?: string;
		country_code?: string;
		type?: string;
	}>;
	org?: {
		company?: string;
		department?: string;
		title?: string;
	};
	urls?: Array<{
		url: string;
		type?: string;
	}>;
	birthday?: string;
}

export interface WABAContactsMessageData extends WABAMessageData {
	type: "contacts";
	contacts: Array<WABAContactData>;
}

export interface WABAMessageFileResponse {
	url: string;
	mime_type: string;
	sha256: string;
	file_size: number;
	id: string;
	messaging_product: string;
}

export interface WABAFileOptions {
	data: ReadStream;
	type: string;
	filename?: string;
}

export interface WABAMessageTemplate {
	name: string;
	components: Array<WABATemplateComponents>;
	language: {
		code: string;
		policy?: string;
	};
	status?: string;
	category?: string;
	id?: string;
}

export type WABATemplateComponents =
	| WABATemplateHeaderComponent
	| WABATemplateBodyComponent
	| WABATemplateFooterComponent
	| WABATemplateButtonComponent;

export type HeaderFormat = "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";

export interface WABATemplateHeaderComponent {
	type: "HEADER";
	format: HeaderFormat;
	text?: string;
	image?: {
		link: string;
	};
	video?: {
		link: string;
	};
	document?: {
		link: string;
		filename?: string;
	};
	location?: {
		latitude: number;
		longitude: number;
		name?: string;
		address?: string;
	};
	example?: {
		header_text?: Array<string>;
		header_handle?: Array<string>;
	};
}

export interface WABATemplateBodyComponent {
	type: "BODY";
	text: string;
	example?: {
		body_text?: Array<string[]>;
	};
}

export interface WABATemplateFooterComponent {
	type: "FOOTER";
	text: string;
}

export interface WABATemplateButtonComponent {
	type: "BUTTONS";
	buttons: Array<WABATemplateButton>;
}

export type WABATemplateButton =
	| WABATemplateURLButton
	| WABATemplatePhoneButton
	| WABATemplateQuickReplyButton
	| WABATemplateCatalogButton
	| WABATemplateFlowButton;

export interface WABATemplateURLButton {
	type: "URL";
	text: string;
	url: string;
	example?: string[];
}

export interface WABATemplatePhoneButton {
	type: "PHONE_NUMBER";
	text: string;
	phone_number: string;
}

export interface WABATemplateQuickReplyButton {
	type: "QUICK_REPLY";
	text: string;
	payload?: string;
}

export interface WABATemplateCatalogButton {
	type: "CATALOG";
	text: string;
}

export interface WABATemplateFlowButton {
	type: "FLOW";
	text: string;
	flow_id: string;
	flow_token: string;
	flow_action?: "navigate" | "data_exchange";
}

export interface WABARecoverTemplatesResponse {
	data: WABAMessageTemplate[];
	paging: {
		cursors: {
			before: string;
			after: string;
		};
		next?: string;
	};
}

export interface ReceiveMessageBody {
	object: string;
	entry: Array<ReceiveMessageEntry>;
}

export interface ReceiveMessageEntry {
	id: string;
	changes: Array<ReceiveMessageChange>;
}

export interface ReceiveMessageChange {
	value: ReceiveMessageChangeValue;
	field: string;
}

export interface ReceiveMessageChangeValue {
	messaging_product: string;
	metadata: {
		display_phone_number: string;
		phone_number_id: string;
	};
	contacts?: Array<ReceiveMessageChangeValueContact>;
	messages?: Array<Message>;
	statuses?: Array<WABAMessageStatusData>;
	errors?: Array<{
		code: number;
		title: string;
		message: string;
		error_data?: {
			details: string;
		};
	}>;
}

export interface ReceiveMessageChangeValueContact {
	profile: {
		name: string;
	};
	wa_id: string;
}

export interface GSWebhookMessage {
	entry: [ReceiveMessageEntry];
	gs_app_id: string;
	object: string;
}
