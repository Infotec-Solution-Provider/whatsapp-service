import { stringify } from "csv-stringify/sync";
import ChatToExport from "../index";
import getDownloadUrl from "../../../utils/get-download-url";

function chatToCsv(instance: string, chat: ChatToExport) {
	const records = [];
	records.push(["Data", "Enviado por", "Mensagem", "Arquivo", "Chat"]);

	chat.getMessages().forEach((m) => {
		let fileUrl = null;

		if ("ARQUIVO_NOME" in m && m.ARQUIVO_NOME && m.ARQUIVO_NOME !== "") {
			fileUrl = getDownloadUrl(m.ARQUIVO_NOME, instance);
		}

		records.push([
			m.DATA_HORA.toLocaleString(),
			m.FROM_ME ? m.OPERADOR_NOME : m.CONTATO_NOME,
			m.MENSAGEM,
			fileUrl,
			chat.phone
		]);
	});

	return stringify(records);
}

export default chatToCsv;
