interface BaseSendMessageOptions {
	to: string;
	quotedId?: string | null;
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
