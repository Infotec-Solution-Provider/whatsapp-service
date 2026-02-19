import { File } from "@in.pulse-crm/sdk";
import { TemplateMessage } from "../adapters/template.adapter";
import { TemplateVariables } from "./whatsapp-api.types";

interface BaseSendMessageOptions {
	to: string;
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
	phone: string;
};

export type Mentions = Mention[];

export type WhatsAppMention = { id: string; tag?: string };

export interface WhatsappTemplate {}


export interface WhatsappGroup {
	id: string;
	name: string;
}