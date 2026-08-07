export type MessageStatus = "PENDING" | "SENT" | "RECEIVED" | "READ" | "DOWNLOADED" | "ERROR" | "REVOKED";

export interface MessageIdentity {
	addressingMode: "pn" | "lid";
	phone: string | null;
	lid: string | null;
	phoneResolved: boolean;
}

export default interface MessageDto {
	instance: string;
	from: string;
	to: string;
	body: string;
	type: string;
	timestamp: string;
	sentAt: Date;
	status: MessageStatus;
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
	isGroup: boolean;
	authorName?: null | string;
	contactName?: null | string;
	groupId?: null | string;
	sender?: MessageIdentity | null;
	recipient?: MessageIdentity | null;
	participant?: MessageIdentity | null;
	clientId: number | null;
	isEdit?: boolean;
	editedTargetMessageId?: string | null;
	editContentAvailable?: boolean;
	isEphemeral?: boolean;
	isViewOnce?: boolean;
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

export interface AuthLogoutEvent {
	type: "auth-logout";
	clientId: number;
	reason?: string;
}

export type RemoteSessionOperationalState =
	| "STARTING"
	| "QR_PENDING"
	| "CONNECTING"
	| "CONNECTED"
	| "RECONNECTING"
	| "DISCONNECTED"
	| "LOGGED_OUT"
	| "ERROR";

export interface RemoteSessionOperation {
	id: string;
	type: "RESTART" | "RESET_AUTH";
	startedAt: string;
}

export interface RemoteSessionInfo {
	contractVersion: 1;
	sessionId: string;
	phone: string;
	status: "open" | "close" | "connecting";
	state: RemoteSessionOperationalState;
	processStartedAt: string;
	stateChangedAt: string;
	observedAt: string;
	lastActivityAt: string | null;
	connectedSince: string | null;
	lastConnectedAt: string | null;
	lastDisconnectedAt: string | null;
	lastDisconnectReason: string | null;
	reconnectAttempts: number;
	lastReconnectAt: string | null;
	qrGeneratedAt: string | null;
	currentOperation: RemoteSessionOperation | null;
}

export interface SessionStatusChangedEvent {
	type: "session-status-changed";
	clientId: number;
	sessionId: string;
	traceId: string;
	occurredAt: string;
	session: RemoteSessionInfo;
}

export interface MessageReceivedEvent {
	type: "message-received";
	clientId: number;
	message: MessageDto;
}

export interface MessageEditedEvent {
	type: "message-edited";
	clientId: number;
	message: MessageDto;
}

export interface MessageReactionEvent {
	type: "message-reaction";
	clientId: number;
	targetMessageId: string;
	reaction: string;
	removed: boolean;
	isGroup: boolean;
	groupId: string | null;
}

export interface MessageRevokedEvent {
	type: "message-revoked";
	clientId: number;
	targetMessageId: string;
	isGroup: boolean;
	groupId: string | null;
}

export interface MessageStatusReceivedEvent {
	type: "message-status-received";
	clientId: number;
	messageId: string;
	status: string;
	timestamp: number;
}

export type RemoteClientEvent = QRReceivedEvent | AuthSuccessEvent | AuthLogoutEvent | SessionStatusChangedEvent | MessageReceivedEvent | MessageEditedEvent | MessageReactionEvent | MessageRevokedEvent | MessageStatusReceivedEvent;
