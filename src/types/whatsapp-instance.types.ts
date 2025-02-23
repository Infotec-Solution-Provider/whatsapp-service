export interface SendMessageOptions {
	instanceName: string;
	from: string;
	to: string;
	text: string;
	isAudio: boolean;
	quotedId?: string;
	file?: Express.Multer.File | string;
}

export interface WhatsappInstanceProps {
	phone: string;
	instanceName: string;
}
