import axios from "axios";
import {
	WABAAudioMessageData,
	WABAMessageData,
	WABAContactData,
	WABAContactsMessageData,
	WABADocumentMessageData,
	WABAImageMessageData,
	Message,
	WABAMessageFileResponse,
	WABATextMessageData,
	WABAVideoMessageData
} from "../types/whatsapp-api.types";

interface MessageContext {
	id: string;
	from: string;
}

export abstract class WABAMessage {
	public readonly id: string;
	public readonly from: string;
	public readonly timestamp: string;
	public readonly context: MessageContext | null;

	protected constructor(message: WABAMessageData) {
		this.id = message.id;
		this.from = message.from;
		this.timestamp = message.timestamp;
		this.context = message.context || null;
	}

	public static fromData(message: Message): WABAMessage {
		switch (message.type) {
			case "text":
				return new WABATextMessage(message);
			case "image":
				return new WABAImageMessage(message);
			case "video":
				return new WABAVideoMessage(message);
			case "audio":
				return new WABAAudioMessage(message);
			case "document":
				return new WABADocumentMessage(message);
			case "contacts":
				return new WABAContactsMessage(message);
			default:
				throw new Error("Invalid message type.");
		}
	}

	protected static async getMedia(
		mediaId: string,
		whatsappToken: string
	): Promise<WABAMessageFileResponse | Error> {
		const requestURL = `https://graph.facebook.com/v16.0/${mediaId}`;
		const axiosConfig = {
			headers: {
				Authorization: `Bearer ${whatsappToken}`
			}
		};

		const fileResponse = await axios
			.get<WABAMessageFileResponse>(requestURL, axiosConfig)
			.then((res) => res.data)
			.catch(() => new Error("failed to get media URL"));

		return fileResponse;
	}
}

export class WABATextMessage extends WABAMessage {
	public readonly type: "text" = "text";
	public readonly text: {
		body: string;
	};

	constructor(message: WABATextMessageData) {
		super(message);
		this.text = message.text;
	}
}

export class WABAAudioMessage extends WABAMessage {
	public readonly type: "audio" = "audio";
	public readonly audio: {
		id: string;
		mime_type: string;
	};

	public async getMedia(whatsappToken: string) {
		return await WABAMessage.getMedia(this.audio.id, whatsappToken);
	}

	constructor(message: WABAAudioMessageData) {
		super(message);
		this.audio = message.audio;
	}
}

export class WABAVideoMessage extends WABAMessage {
	public readonly type: "video" = "video";
	public readonly video: {
		id: string;
		mime_type: string;
		caption?: string;
	};

	public async getMedia(whatsappToken: string) {
		return await WABAMessage.getMedia(this.video.id, whatsappToken);
	}

	constructor(message: WABAVideoMessageData) {
		super(message);
		this.video = message.video;
	}
}

export class WABAImageMessage extends WABAMessage {
	public readonly type: "image" = "image";
	public readonly image: {
		id: string;
		mime_type: string;
		caption?: string;
	};

	public async getMedia(whatsappToken: string) {
		return await WABAMessage.getMedia(this.image.id, whatsappToken);
	}

	constructor(message: WABAImageMessageData) {
		super(message);
		this.image = message.image;
	}
}

export class WABADocumentMessage extends WABAMessage {
	public readonly type: "document" = "document";
	public readonly document: {
		id: string;
		mime_type: string;
		filename?: string;
	};

	public async getMedia(whatsappToken: string) {
		return await WABAMessage.getMedia(this.document.id, whatsappToken);
	}

	constructor(message: WABADocumentMessageData) {
		super(message);
		this.document = message.document;
	}
}

export class WABAContactsMessage extends WABAMessage {
	public readonly type: "contacts" = "contacts";
	public readonly contacts: Array<WABAContactData>;

	constructor(message: WABAContactsMessageData) {
		super(message);
		this.contacts = message.contacts;
	}
}

export type WhatsappMessage =
	| WABATextMessageData
	| WABAAudioMessageData
	| WABAImageMessageData
	| WABAVideoMessageData
	| WABADocumentMessageData
	| WABAContactsMessageData;

export type WhatsappMessageWithMedia =
	| WABAAudioMessageData
	| WABAVideoMessageData
	| WABAImageMessageData
	| WABADocumentMessageData;
