import { SavedMessage } from "../../../types/export-chats.types";
import instanceService from "../../instances.service";

const baseQuery = `
	SELECT wm.*,
		   o.NOME             AS OPERADOR_NOME,
		   wf.NOME_ARQUIVO    AS ARQUIVO_NOME,
		   wf.TIPO            AS ARQUIVO_TIPO,
		   wf.NOME_ORIGINAL   AS ARQUIVO_NOME_ORIGINAL,
		   wcn.NOME           AS CONTATO_NOME,
		   wcn.NUMERO         AS CONTATO_NUMERO,
		   wcn.CODIGO_CLIENTE AS CONTATO_CLIENTE
	FROM w_mensagens wm
			 LEFT JOIN operadores o ON o.CODIGO = wm.CODIGO_OPERADOR
			 LEFT JOIN w_mensagens_arquivos wf ON wf.CODIGO_MENSAGEM = wm.CODIGO
			 LEFT JOIN w_clientes_numeros wcn ON wcn.CODIGO = wm.CODIGO_NUMERO`;

async function fetchMessages(
	instance: string,
	userId: string,
	startDate: string,
	endDate: string
) {
	const params: Array<string | number> = [];
	let query: string;

	if (userId === "*") {
		query =
			baseQuery + " WHERE DATA_HORA BETWEEN ? AND ? ORDER BY DATA_HORA;";
		params.push(startDate, endDate);
	} else {
		query =
			baseQuery +
			" WHERE CODIGO_OPERADOR = ? AND DATA_HORA BETWEEN ? AND ? ORDER BY DATA_HORA;";
		params.push(+userId, startDate, endDate);
	}

	const result = await instanceService.executeQuery<Array<SavedMessage>>(
		instance,
		query,
		params
	);

	console.log(result);

	return result;

	/*return (await qr.run<Array<SavedMessage>>(query, params)).map((m) => {
		if (!!m.MENSAGEM) {
			m.MENSAGEM = decodeURI(m.MENSAGEM);
		}
		if ("ARQUIVO_NOME" in m && !!m.ARQUIVO_NOME) {
			m.ARQUIVO_NOME = decodeURI(m.ARQUIVO_NOME);
		}
		if ("ARQUIVO_NOME_ORIGINAL" in m && !!m.ARQUIVO_NOME_ORIGINAL) {
			m.ARQUIVO_NOME_ORIGINAL = decodeURI(m.ARQUIVO_NOME_ORIGINAL);
		}

		return m;
	});*/
}

export default fetchMessages;
