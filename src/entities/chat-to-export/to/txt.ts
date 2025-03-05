import { SavedMessage } from "../../../types/export-chats.types";
import ChatToExport from "../index";
import getAttachmentType from "../../../utils/get-attachment-type";
import getDownloadUrl from "../../../utils/get-download-url";

function formatMessage(m: SavedMessage, instance: string): string {
	let messageText = `[${m.DATA_HORA.toLocaleString()}] ${m.MENSAGEM}`;

	if ("ARQUIVO_NOME" in m && m.ARQUIVO_NOME && m.ARQUIVO_NOME !== "") {
		const type = getAttachmentType(m.TIPO);
		const link = getDownloadUrl(m.ARQUIVO_NOME, instance);
		messageText =
			messageText + `\n(${type}) ${m.ARQUIVO_NOME_ORIGINAL}: ${link}\n`;
	}

	return messageText;
}

function chatToTxt(instance: string, chat: ChatToExport) {
	return chat
		.getMessages()
		.map((message) => formatMessage(message, instance))
		.join("\n");
}

export default chatToTxt;
