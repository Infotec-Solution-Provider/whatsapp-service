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
	| "document"
	| "sticker";

export type GSMessageData =
	| GSTextMessageData
	| GSAudioMessageData
	| GSVideoMessageData
	| GSImageMessageData
	| GSDocumentMessageData
	| GSContactsMessageData
	| GSStickerMessageData;

export type MessageStatus = "read" | "delivered" | "sent" | "enqueued";

export interface GSMessageStatusData {
	id: string;
	status: MessageStatus;
	timestamp: string;
	recipient_id: string;
	biz_opaque_callback_data: string;
	gs_id: string;
	meta_msg_id: string;
	errors?: Array<GSMessageStatusError>;
}
export interface GSMessageStatusError {
	code: number;
	error_data: {
		details: string;
	};
	message: string;
	title: string;
}
export interface GSBaseMessageData {
	from: string;
	id: string;
	timestamp: string;
	type: MessageType;
	context?: {
		id?: string;
		from?: string;
		forwarded?: boolean;
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

export interface GSStickerMessageData extends GSBaseMessageData {
	type: "sticker";
	sticker: {
		animated: boolean;
		mime_type: string;
		sha256: string;
		id: string;
		url: string;
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
	appId: string;
	category: string;
	contanerMeta: string;
	createdOn: number;
	data: string; // Texto do template
	elementName: string; // Nome do template
	externalId: string;
	id: string;
	internalCategory: string;
	internalType: string;
	languageCode: string;
	languagePolicy: string;
	meta: string;
	modifiedOn: number;
	namespace: string;
	priority: number;
	quality: string;
	retry: number;
	stage: string;
	status: string;
	templateType: string;
	vertical: string;
	wabaId: string;
	buttonSupported?: string;
}

export interface GSRecoverTemplatesResponse {
	templates: GSMessageTemplate[];
	status: string;
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
