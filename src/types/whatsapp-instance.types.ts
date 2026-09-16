import { File } from "../sdk-local";
import { TemplateMessage } from "../adapters/template.adapter";
import { TemplateVariables } from "./whatsapp-api.types";

interface BaseSendMessageOptions {
	/** Correlates an operator attempt with provider processing logs. */
	traceId?: string;
	to: string;
	/** Durable caller owns recovery; do not retry an ambiguous provider dispatch. */
	preventAutomaticRetry?: boolean;
	quotedId?: string | null;
	mentions?: Mentions;
}

export type SendFileType = "image" | "video" | "audio" | "document";

export interface SendFileOptions extends BaseSendMessageOptions {
	text?: string | null;
	sendAsAudio?: boolean;
	sendAsDocument?: boolean;
	fileId: number;
	localFileUrl: string;
	publicFileUrl: string;
	file: File;
}

export interface SendTextOptions extends BaseSendMessageOptions {
	text: string;
}

export type SendMessageOptions = SendTextOptions | SendFileOptions;

export interface EditMessageOptions {
	messageId: string;
	text: string;
	mentions?: Mentions | null;
}

export interface SendReactionOptions {
	to: string;
	messageId: string;
	emoji: string;
	isGroup?: boolean;
}

export interface SendReactionResult {
	contractVersion: 1;
	status: "SENT";
	targetMessageId: string;
	reaction: string;
	removed: boolean;
	fromMe: true;
	actorId?: string;
	timestamp: number;
	reactionId: string;
}

export interface SendTemplateOptions extends BaseSendMessageOptions {
	template: TemplateMessage;
	templateVariables: TemplateVariables;
	components: string[];
}

export interface WhatsappInstanceProps {
	phone: string;
	instanceName: string;
}
export type Mention = {
	userId: number;
	name: string;
	// Legacy field kept for payload compatibility; notification target is resolved by userId -> operator WHATSAPP.
	phone?: string;
};

export type Mentions = Mention[];

export type WhatsAppMention = { id: string; tag?: string };

export interface WhatsappTemplate {}


export interface WhatsappGroup {
	id: string;
	name: string;
}
