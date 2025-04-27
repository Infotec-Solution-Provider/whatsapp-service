import { WppMessageStatus } from "@prisma/client";

export default interface CreateInternalMessageDto {
	instance: string;
	from: string;
	to: string;
	body: string;
	type: string;
	timestamp: string;
	status: WppMessageStatus;
	quotedId?: null | number;
	internalchatId?: null | number;
	internalcontactId?: null | number;
	fileId?: null | number;
	fileName?: null | string;
	fileType?: null | string;
	fileSize?: null | string;
}
