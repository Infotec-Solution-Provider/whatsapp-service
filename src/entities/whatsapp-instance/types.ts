export interface WppClientConstructorProps {
	phone: string;
	instanceName: string;
}

export interface WppClientSendMessageOptions {
	instanceName: string;
	from: string;
	to: string;
	text: string;
	isAudio: boolean;
	quotedId?: string;
	file?: Express.Multer.File | string;
}
