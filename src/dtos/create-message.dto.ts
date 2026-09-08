import { WppMessageStatus } from "@prisma/client";
import type { MentionEntity } from "../utils/message-mention-metadata";

export default interface CreateMessageDto {
	instance: string;
	from: string;
	to: string;
	body: string;
	mentionEntities?: MentionEntity[];
	type: string;
	timestamp: string;
	sentAt: Date;
	status: WppMessageStatus;
	quotedId?: null | number | string;
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
	agentId?: null | number;
	clientId: number | null;
}
