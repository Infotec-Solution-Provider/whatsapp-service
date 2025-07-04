interface BaseSendMessageOptions {
	to: string;
	quotedId?: string | null;
	mentions?: Mentions
}

export interface SendFileOptions extends BaseSendMessageOptions {
	text?: string | null;
	sendAsAudio?: boolean;
	sendAsDocument?: boolean;
	fileUrl: string;
	fileName: string;
}

export interface SendTextOptions extends BaseSendMessageOptions {
	text: string;
}

export type SendMessageOptions = SendTextOptions | SendFileOptions;
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
