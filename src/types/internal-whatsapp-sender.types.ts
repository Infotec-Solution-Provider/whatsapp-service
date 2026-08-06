export interface InternalWhatsappSenderListInput {
	page: number;
	perPage: number;
	search: string;
}

export interface InternalWhatsappSenderMessagesInput {
	senderId: string;
	limit: number;
	beforeId: number | null;
}
