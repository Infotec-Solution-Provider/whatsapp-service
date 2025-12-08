export type MessageStatus = "PENDING" | "SENT" | "RECEIVED" | "READ" | "DOWNLOADED" | "ERROR" | "REVOKED";

export default interface MessageDto {
	instance: string;
	from: string;
	to: string;
	body: string;
	type: string;
	timestamp: string;
	sentAt: Date;
	status: MessageStatus;
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
	isForwarded?: boolean;
	groupId: string | null;
	clientId: number | null;
	contactName: string;
}

export interface QRReceivedEvent {
	type: "qr-received";
	clientId: number;
	qr: string;
}

export interface AuthSuccessEvent {
	type: "auth-success";
	clientId: number;
	phoneNumber: string;
}

export interface MessageReceivedEvent {
	type: "message-received";
	clientId: number;
	message: MessageDto;
}

export interface MessageStatusReceivedEvent {
	type: "message-status-received";
	clientId: number;
	messageId: string;
	status: string;
	timestamp: number;
}

export type RemoteClientEvent = QRReceivedEvent | AuthSuccessEvent | MessageReceivedEvent | MessageStatusReceivedEvent;
