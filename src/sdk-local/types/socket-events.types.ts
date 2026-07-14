import {
	SocketServerAdminRoom,
	SocketServerChatRoom,
	SocketServerInternalChatRoom,
	SocketServerReportsRoom,
	SocketServerRoom,
	SocketServerUserRoom,
} from "./socket-rooms.types";
import { MessageResponse } from "./response.types";
import { WppMessage, WppMessageStatus } from "./whatsapp.types";
import {
	InternalChat,
	InternalChatMember,
	InternalMessage,
} from "./internal.types";

export enum SocketEventType {
	WppChatStarted = "wpp_chat_started",
	WppChatFinished = "wpp_chat_finished",
	WppChatTransfer = "wpp_chat_transfer",
	WppMessage = "wpp_message",
	WppMessageEdit = "wpp_message_edit",
	WppMessageDelete = "wpp_message_delete",
	WppMessageStatus = "wpp_message_status",
	WppMessageReaction = "wpp_message_reaction",
	WppContactMessagesRead = "wpp_contact_messages_read",
	WwebjsQr = "wwebjs_qr",
	WwebjsAuth = "wwebjs_auth",
	ReportStatus = "report_status",
	InternalChatStarted = "internal_chat_started",
	InternalChatFinished = "internal_chat_finished",
	InternalMessage = "internal_message",
	InternalMessageEdit = "internal_message_edit",
	InternalMessageDelete = "internal_message_delete",
	InternalMessageStatus = "internal_message_status",
	TelephonyCallReceived = "telephony_call_received",
}

export interface EmitSocketEventFn {
	(
		type: SocketEventType.WwebjsQr,
		room: SocketServerAdminRoom,
		data: WWEBJSQrEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.WwebjsAuth,
		room: SocketServerAdminRoom,
		data: WWEBJSAuthEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.WppChatStarted,
		room: SocketServerRoom,
		data: WppChatStartedEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.WppChatFinished,
		room: SocketServerRoom,
		data: WppChatFinishedEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.WppChatTransfer,
		room: SocketServerRoom,
		data: WppChatTransferEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.WppMessage,
		room: SocketServerChatRoom,
		data: WppMessageEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.WppMessageEdit,
		room: SocketServerChatRoom,
		data: WppMessageEditEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.WppMessageDelete,
		room: SocketServerChatRoom,
		data: WppMessageDeleteEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.WppMessageStatus,
		room: SocketServerChatRoom,
		data: WppMessageStatusEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.WppContactMessagesRead,
		room: SocketServerChatRoom,
		data: WppContactMessagesReadEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.WppMessageReaction,
		room: SocketServerChatRoom,
		data: WppMessageReactionEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.ReportStatus,
		room: SocketServerReportsRoom,
		data: ReportStatusEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.InternalMessage,
		room: SocketServerInternalChatRoom,
		data: InternalMessageEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.InternalMessageEdit,
		room: SocketServerInternalChatRoom,
		data: InternalMessageEditEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.InternalMessageDelete,
		room: SocketServerInternalChatRoom,
		data: InternalMessageDeleteEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.InternalMessageStatus,
		room: SocketServerInternalChatRoom,
		data: InternalMessageStatusEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.InternalChatStarted,
		room: SocketServerRoom,
		data: InternalChatStartedEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.InternalChatFinished,
		room: SocketServerRoom,
		data: InternalChatFinishedEventData,
	): Promise<MessageResponse>;
	(
		type: SocketEventType.TelephonyCallReceived,
		room: SocketServerUserRoom,
		data: TelephonyCallReceivedEventData,
	): Promise<MessageResponse>;
}

export interface ListenSocketEventFn {
	(
		type: SocketEventType.WwebjsQr,
		callback: (data: WWEBJSQrEventData) => void,
	): void;
	(
		type: SocketEventType.WwebjsAuth,
		callback: (data: WWEBJSAuthEventData) => void,
	): void;
	(
		type: SocketEventType.WppChatStarted,
		callback: (data: WppChatStartedEventData) => void,
	): void;
	(
		type: SocketEventType.WppChatFinished,
		callback: (data: WppChatFinishedEventData) => void,
	): void;
	(
		type: SocketEventType.WppChatTransfer,
		callback: (data: WppChatTransferEventData) => void,
	): void;
	(
		type: SocketEventType.WppMessage,
		callback: (data: WppMessageEventData) => void,
	): void;
	(
		type: SocketEventType.WppMessageStatus,
		callback: (data: WppMessageStatusEventData) => void,
	): void;
	(
		type: SocketEventType.WppContactMessagesRead,
		callback: (data: WppContactMessagesReadEventData) => void,
	): void;
	(
		type: SocketEventType.WppMessageReaction,
		callback: (data: WppMessageReactionEventData) => void,
	): void;
	(
		type: SocketEventType.ReportStatus,
		callback: (data: ReportStatusEventData) => void,
	): void;
	(
		type: SocketEventType.InternalChatStarted,
		callback: (data: InternalChatStartedEventData) => void,
	): void;
	(
		type: SocketEventType.InternalChatFinished,
		callback: (data: InternalChatFinishedEventData) => void,
	): void;
	(
		type: SocketEventType.InternalMessage,
		callback: (data: InternalMessageEventData) => void,
	): void;
	(
		type: SocketEventType.InternalMessageEdit,
		callback: (data: InternalMessageEditEventData) => void,
	): void;
	(
		type: SocketEventType.InternalMessageDelete,
		callback: (data: InternalMessageDeleteEventData) => void,
	): void;
	(
		type: SocketEventType.InternalMessageStatus,
		callback: (data: InternalMessageStatusEventData) => void,
	): void;
	(
		type: SocketEventType.WppMessageEdit,
		callback: (data: WppMessageEditEventData) => void,
	): void;
	(
		type: SocketEventType.WppMessageDelete,
		callback: (data: WppMessageDeleteEventData) => void,
	): void;
	(
		type: SocketEventType.TelephonyCallReceived,
		callback: (data: TelephonyCallReceivedEventData) => void,
	): void;
}

export interface UnlistenSocketEventFn {
	(type: SocketEventType): void;
}

// EventData types
export interface WWEBJSQrEventData {
	qr: string;
	phone: string;
}
export interface WWEBJSAuthEventData {
	phone: string;
	success: boolean;
	message?: string;
}
export interface WppChatStartedEventData {
	chatId: number;
}
export interface WppChatFinishedEventData {
	chatId: number;
}
export interface WppChatTransferEventData {
	chatId: number;
}
export interface WppContactMessagesReadEventData {
	contactId: number;
}
export interface WppMessageEventData {
	message: WppMessage;
}

export interface WppMessageEditEventData {
	contactId: number;
	messageId: number;
	newText: string;
}

export interface WppMessageDeleteEventData {
	contactId: number;
	messageId: number;
}
export interface WppMessageStatusEventData {
	messageId: number;
	contactId: number;
	status: WppMessageStatus;
}
export interface WppMessageReactionEventData {
	messageId: number;
	reaction: string;
}
export interface InternalChatStartedEventData {
	chat: InternalChat & {
		participants: InternalChatMember[];
		messages: InternalMessage[];
	};
}
export interface InternalChatFinishedEventData {
	chatId: number;
}
export interface InternalChatTransferEventData {
	chatId: number;
}
export interface InternalContactMessagesReadEventData {
	contactId: number;
}
export interface InternalMessageEventData {
	message: InternalMessage;
}
export interface InternalMessageEditEventData {
	chatId: number;
	internalMessageId: number;
	newText: string;
}
export interface InternalMessageDeleteEventData {
	chatId: number;
	internalMessageId: number;
}
export interface InternalMessageStatusEventData {
	chatId: number;
	internalMessageId: number;
	status: WppMessageStatus;
}

export type ReportStatusEventData = {
	id: number;
	type: string;
} & (
		| {
			isCompleted: true;
			isFailed: false;
			fileId: number;
			chats: number;
			messages: number;
		}
		| {
			isCompleted: false;
			isFailed: true;
			error: string;
		}
		| {
			isCompleted: false;
			isFailed: false;
			progress: number;
		}
	);

export interface TelephonyCallReceivedEventData {
	uniqueid: string;
	callerNumber: string;
	callerName: string | null;
	ramal: string;
	operatorId: number | null;
	instance: string;
	receivedAt: string;
	receptiveCallId: number | null;
}
