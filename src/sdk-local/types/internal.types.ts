import { WppMessageStatus } from "./whatsapp.types";

export interface InternalMessage {
	id: number;
	instance: string;
	from: string;
	type: string;
	quotedId: number | null;
	internalChatId: number;
	body: string;
	timestamp: string;
	isForwarded: boolean;
	isEdited: boolean;
	status: WppMessageStatus;
	fileId: number | null;
	fileName: string | null;
	fileType: string | null;
	fileSize: string | null;
}

export interface InternalChat {
	id: number;
	instance: string;
	creatorId: number | null;
	sectorId: number | null;
	isFinished: boolean;
	startedAt: Date;
	finishedAt: Date | null;
	finishedBy: number | null;
	isGroup: boolean;
	groupName: string | null;
	groupDescription: string | null;
	groupImageFileId: number | null;
}

export interface InternalGroup {
	id: number;
	instance: string;
	creatorId: number | null;
	sectorId: number | null;
	isFinished: true;
	startedAt: Date;
	finishedAt: Date | null;
	finishedBy: number | null;
	isGroup: boolean;
	groupName: string | null;
	groupDescription: string | null;
	groupImageFileId: number | null;
	participants: {
		userId: number;
		joinedAt: Date;
		lastReadAt: Date | null;
		internalChatId: number;
	}[];
	wppGroupId: string | null;
}

export interface InternalChatMember {
	internalChatId: number;
	userId: number;
	joinedAt: string;
	lastReadAt?: string | null;
	lastReadId?: number | null;
}

export interface InternalSendMessageData {
	sendAsAudio?: boolean;
	sendAsDocument?: boolean;
	quotedId?: number | null;
	chatId: number;
	text: string;
	file?: File;
	fileId?: number;
	mentions?: MentionData[];
	traceId?: string;
}
export interface MentionData {
	userId: number;
	name: string;
	phone: string;
}