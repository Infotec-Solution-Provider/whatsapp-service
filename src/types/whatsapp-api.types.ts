import { ReadStream } from "fs";

export type MessageType =
	| "text"
	| "reaction"
	| "image"
	| "video"
	| "audio"
	| "location"
	| "contacts"
	| "interactive"
	| "document";
export type Message =
	| WABATextMessageData
	| WABAAudioMessageData
	| WABAVideoMessageData
	| WABAImageMessageData
	| WABADocumentMessageData
	| WABAContactsMessageData;
export type MessageStatus = "read" | "delivered" | "sent";

export interface WABAMessageStatusData {
	id: string;
	status: MessageStatus;
	timestamp: string;
	recipient_id: string;
	biz_opaque_callback_data: string;
	gs_id: string;
	meta_msg_id: string;
}

export interface WABAMessageData {
	id: string;
	from: string;
	timestamp: string;
	type: MessageType;
	message_status: MessageStatus;
	context?: {
		id: string;
		from: string;
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
	};
}

export interface WABAImageMessageData extends WABAMessageData {
	type: "image";
	image: {
		id: string;
		mime_type: string;
		caption?: string;
	};
}

export interface WABADocumentMessageData extends WABAMessageData {
	type: "document";
	document: {
		id: string;
		mime_type: string;
		filename: string;
		sha256: string;
	};
}

export interface WABAPhoneData {
	phone: string;
	type: string;
}

export interface WABAEmailData {
	email: string;
}

export interface WABAContactData {
	name: {
		first_name: string;
		last_name: string;
		formatted_name: string;
	};
	phones: Array<WABAPhoneData>;
	emails: Array<WABAEmailData>;
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
}

export interface WABAMessageTemplate {
	name: string;
	components: Array<WABATemplateComponents>;
	language: string;
	status: string;
	category: string;
	id: string;
}

export type WABATemplateComponents =
	| WABATemplateHeaderComponent
	| WABATemplateBodyComponent
	| WABATemplateFooterComponent;

export interface WABATemplateHeaderComponent {
	type: "HEADER";
	format: "string";
	text: string;
	example?: {
		header_text?: Array<string>;
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

export interface WABARecoverTemplatesResponse {
	data: WABAMessageTemplate[];
	paging: {
		cursors: {
			before: string;
			after: string;
		};
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
