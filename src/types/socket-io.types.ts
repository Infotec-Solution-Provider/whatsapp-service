export enum SocketEventType {
	MESSAGE = "message",
	MESSAGE_EDIT = "message_edit",
	MESSAGE_STATUS = "message_status",
	NEW_CHAT = "new_chat",
	CHAT_FINISHED = "chat_finished",
	NOTIFICATION = "notification",
	QR_CODE = "qr_code"
}

export interface ChatFinishedEventProps {
	chatId: number;
}

export interface QrCodeEventProps {
	qr: string;
}

export type SocketEventValue = ChatFinishedEventProps | QrCodeEventProps;
