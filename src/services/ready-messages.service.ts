import {
	FileDirType,
	SessionData,
} from "@in.pulse-crm/sdk";
import filesService from "./files.service";
import instancesService from "./instances.service";
import { plainToInstance } from "class-transformer";


class ReadyMessage {
	CODIGO!: number;
	APENAS_ADMIN!: boolean;
	TITULO!: string;
	TEXTO_MENSAGEM!: string;
	ARQUIVO_CODIGO!: number;
	ARQUIVO_NOME!: string;
	ARQUIVO_TIPO!: string;
	LAST_UPDATE!: string;
}
interface CreateReadyMessageDto {
    SETOR: string;
    TEXTO_MENSAGEM: string;
    TITULO: string;
};


class ReadyMessagesService {
	public async createReadyMessage(
		session: SessionData,
		data: CreateReadyMessageDto,
		file: Express.Multer.File | null = null
	) {
		let arquivo;

		data.TEXTO_MENSAGEM = encodeURI(data.TEXTO_MENSAGEM);
		data.TITULO = encodeURI(data.TITULO);
		if (file) {
			const fileData = await filesService.uploadFile({
				instance:'infotec',
				fileName: file.originalname,
				buffer: file.buffer,
				mimeType: file.mimetype,
				dirType: FileDirType.PUBLIC
			});

			arquivo = fileData;
		}
		const INSERT_QUERY = `INSERT INTO w_mensagens_prontas (SETOR, TEXTO_MENSAGEM, TITULO, ARQUIVO, ARQUIVO_CODIGO, LAST_UPDATE)
		VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`;

		let readyMessage = await instancesService.executeQuery<{ insertId: number }>(session.instance, INSERT_QUERY,
			[data.SETOR, data.TEXTO_MENSAGEM, data.TITULO, arquivo?.name,arquivo?.id ]);

		const selectQuery = `SELECT * FROM w_mensagens_prontas WHERE CODIGO = ? LIMIT 1`;

		let result = await instancesService.executeQuery<Array<ReadyMessage>>(session.instance, selectQuery,
				[readyMessage.insertId]);

		result.map(m => {
			m.TITULO = decodeURI(m.TITULO);
			m.TEXTO_MENSAGEM = decodeURI(m.TEXTO_MENSAGEM);

			return m;
		})

		return result[0];
	}
	public async getReadyMessages(session: SessionData) {
		const query = `
		SELECT *
		FROM w_mensagens_prontas
		ORDER BY w_mensagens_prontas.TITULO ASC`;

		let result = await instancesService.executeQuery<Array<ReadyMessage>>(session.instance, query,
			[])

		result.map(m => {
			m.TITULO = decodeURI(m.TITULO);
			m.TEXTO_MENSAGEM = decodeURI(m.TEXTO_MENSAGEM);

			return m;
		})

		return result;
	}
	public async updateReadyMessage(
		session: SessionData,
		readyMessageId: number,
		data: Partial<ReadyMessage>,
		file: Express.Multer.File
	) {
		const fields = [];
		const values: any[] = [];

		if (data.TITULO) data.TITULO = encodeURI(data.TITULO);
		if (data.TEXTO_MENSAGEM) data.TEXTO_MENSAGEM = encodeURI(data.TEXTO_MENSAGEM);


		const fileData = await filesService.uploadFile({
			instance: session.instance,
			fileName: file.originalname,
			buffer: file.buffer,
			mimeType: file.mimetype,
			dirType: FileDirType.PUBLIC
		});

		for (const [key, value] of Object.entries({ ...data, ARQUIVO: fileData.name })) {
			if (typeof value === 'string') {
				fields.push(key);
				values.push(`'${value}'`);
			};

			if (typeof value === 'number') {
				fields.push(key);
				values.push(value);
			};
		};
		const updateQuery = `UPDATE w_mensagens_prontas
			SET ${fields.map((field, index) => `${field} = ${values[index]}`).join(', ')}, LAST_UPDATE = CURRENT_TIMESTAMP()
			WHERE CODIGO = ${readyMessageId};
			`;
		if (!fields.length || !values.length) {
			throw new Error("You must send at least one field to update.");
		};
		const selectQuery = `SELECT * FROM w_mensagens_prontas WHERE CODIGO = ${readyMessageId}`;
		await instancesService.executeQuery<Array<ReadyMessage>>(session.instance, updateQuery,
			[])
		const updatedReadyMessage = instancesService.executeQuery(session.instance,updateQuery,[])
			.then(async () => {
				return await instancesService.executeQuery(session.instance,selectQuery,[])
					.then((res) => plainToInstance(ReadyMessage, res[0][0]))
					.catch((err) => {
						throw new Error(err);
					});
			})
			.catch((err) => {
				throw new Error(err);
			});

		return updatedReadyMessage;
	}
	public async deleteReadyMessage(session: SessionData,
		id: number) {

		const deleteQuery = `DELETE FROM w_mensagens_prontas WHERE CODIGO = ?;`;
		await instancesService.executeQuery<Array<ReadyMessage>>(session.instance, deleteQuery,
			[id])
		}

}

export default new ReadyMessagesService();
