import ChatToExport from "./index";
import { SavedMessage } from "../../types/export-chats.types";

class ChatToExportFactory {
	public static buildChats(messages: Array<SavedMessage>) {
		const chats = new Map<number, ChatToExport>();

		for (const message of messages) {
			const id = message.CODIGO_NUMERO;
			const phone = message.CONTATO_NUMERO;
			const chat =
				chats.get(id) ??
				chats.set(id, new ChatToExport(phone)).get(id)!;

			chat.addMessage(message);

			if (chat.getMessages().length > 200) chat.removeOldestMessage();
		}

		return Array.from(chats.values());
	}
}

export default ChatToExportFactory;
