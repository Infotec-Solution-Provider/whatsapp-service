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

export type GSMessageData =
	| GSTextMessageData
	| GSAudioMessageData
	| GSVideoMessageData
	| GSImageMessageData
	| GSDocumentMessageData
	| GSContactsMessageData;

export type MessageStatus = "read" | "delivered" | "sent";

export interface GSMessageStatusData {
	id: string;
	status: MessageStatus;
	timestamp: string;
	recipient_id: string;
}

export interface GSBaseMessageData {
	from: string;
	id: string;
	timestamp: string;
	type: MessageType;
	context?: {
		id: string;
		from: string;
	};
}

export interface GSTextMessageData extends GSBaseMessageData {
	type: "text";
	text: {
		body: string;
	};
}

export interface GSAudioMessageData extends GSBaseMessageData {
	type: "audio";
	audio: {
		id: string;
		mime_type: string;
		sha256: string;
		voice: boolean;
		url: string;
	};
}

export interface GSVideoMessageData extends GSBaseMessageData {
	type: "video";
	video: {
		caption?: string;
		id: string;
		mime_type: string;
		sha256: string;
		url: string;
	};
}

export interface GSImageMessageData extends GSBaseMessageData {
	type: "image";
	image: {
		caption?: string;
		id: string;
		mime_type: string;
		sha256: string;
		url: string;
	};
}

export interface GSDocumentMessageData extends GSBaseMessageData {
	type: "document";
	document: {
		id: string;
		mime_type: string;
		sha256: string;
		url: string;
		filename: string;
		caption?: string;
	};
}

export interface GSPhoneData {
	phone: string;
	type: string;
}

export interface GSEmailData {
	email: string;
}

export interface GSContactData {
	name: {
		first_name: string;
		last_name: string;
		formatted_name: string;
	};
	phones: Array<GSPhoneData>;
	emails: Array<GSEmailData>;
}

export interface GSContactsMessageData extends GSBaseMessageData {
	type: "contacts";
	contacts: Array<GSContactData>;
}

export interface GSMessageFileResponse {
	url: string;
	mime_type: string;
	sha256: string;
	file_size: number;
	id: string;
	messaging_product: string;
}

export interface GSFileOptions {
	data: ReadStream;
	type: string;
}

export interface GSMessageTemplate {
	name: string;
	components: Array<GSTemplateComponents>;
	language: string;
	status: string;
	category: string;
	id: string;
}

export type GSTemplateComponents =
	| GSTemplateHeaderComponent
	| GSTemplateBodyComponent
	| GSTemplateFooterComponent;

export interface GSTemplateHeaderComponent {
	type: "HEADER";
	format: "string";
	text: string;
	example?: {
		header_text?: Array<string>;
	};
}

export interface GSTemplateBodyComponent {
	type: "BODY";
	text: string;
	example?: {
		body_text?: Array<string[]>;
	};
}

export interface GSTemplateFooterComponent {
	type: "FOOTER";
	text: string;
}

export interface GSRecoverTemplatesResponse {
	data: GSMessageTemplate[];
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
	messages?: Array<GSMessageData>;
	statuses?: Array<GSMessageStatusData>;
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
