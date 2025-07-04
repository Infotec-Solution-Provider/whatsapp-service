import { WppMessageStatus } from "@prisma/client";

export default interface CreateMessageDto {
	instance: string;
	from: string;
	to: string;
	body: string;
	type: string;
	timestamp: string;
	status: WppMessageStatus;
	quotedId?: null | number;
	chatId?: null | number;
	contactId?: null | number;
	wwebjsId?: null | string;
	wwebjsIdStanza?: null | string;
	wabaId?: null | string;
	fileId?: null | number;
	fileName?: null | string;
	fileType?: null | string;
	fileSize?: null | string;
	isForwarded?: false | boolean;
}
