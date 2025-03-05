import {
	ExportChatFileFormat,
	SavedMessage
} from "../../types/export-chats.types";
import chatToHtml from "./to/html";
import chatToCsv from "./to/csv";
import chatToTxt from "./to/txt";

export default class ChatToExport {
	public readonly phone: string;
	private readonly messages: Array<SavedMessage> = [];

	constructor(phone: string) {
		this.phone = phone;
	}

	public addMessage(message: SavedMessage) {
		this.messages.push(message);
	}

	public getMessages() {
		return this.messages;
	}

	public removeOldestMessage() {
		this.messages.shift();
	}

	public toFile(instance: string, format: ExportChatFileFormat) {
		switch (format) {
			case ExportChatFileFormat.PDF:
				return chatToHtml(instance, this);
			case ExportChatFileFormat.CSV:
				return chatToCsv(instance, this);
			case ExportChatFileFormat.TXT:
				return chatToTxt(instance, this);
			default:
				throw new Error("Formato inválido");
		}
	}
}
