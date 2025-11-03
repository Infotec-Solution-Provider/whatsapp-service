import { WppMessageStatus } from "@prisma/client";

export default interface CreateMessageDto {
	instance: string;
	from: string;
	to: string;
	body: string;
	type: string;
	timestamp: string;
	sentAt: Date;
	status: WppMessageStatus;
	quotedId?: null | number;
	chatId?: null | number;
	contactId?: null | number;
	userId?: number;
	wwebjsId?: null | string;
	wwebjsIdStanza?: null | string;
	gupshupId?: null | string;
	wabaId?: null | string;
	fileId?: null | number;
	fileName?: null | string;
	fileType?: null | string;
	fileSize?: null | string;
	isForwarded?: false | boolean;
	clientId: number;
}
