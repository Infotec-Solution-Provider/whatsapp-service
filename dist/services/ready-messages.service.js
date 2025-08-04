"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const sdk_1 = require("@in.pulse-crm/sdk");
const files_service_1 = __importDefault(require("./files.service"));
const instances_service_1 = __importDefault(require("./instances.service"));
const class_transformer_1 = require("class-transformer");
class ReadyMessage {
    CODIGO;
    APENAS_ADMIN;
    TITULO;
    TEXTO_MENSAGEM;
    ARQUIVO_CODIGO;
    ARQUIVO_NOME;
    ARQUIVO_TIPO;
    LAST_UPDATE;
}
;
class ReadyMessagesService {
    async createReadyMessage(session, data, file = null) {
        let arquivo;
        data.TEXTO_MENSAGEM = encodeURI(data.TEXTO_MENSAGEM);
        data.TITULO = encodeURI(data.TITULO);
        if (file) {
            const fileData = await files_service_1.default.uploadFile({
                instance: 'infotec',
                fileName: file.originalname,
                buffer: file.buffer,
                mimeType: file.mimetype,
                dirType: sdk_1.FileDirType.PUBLIC
            });
            arquivo = fileData;
        }
        const INSERT_QUERY = `INSERT INTO w_mensagens_prontas (SETOR, TEXTO_MENSAGEM, TITULO, ARQUIVO, ARQUIVO_CODIGO, LAST_UPDATE)
		VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`;
        let readyMessage = await instances_service_1.default.executeQuery(session.instance, INSERT_QUERY, [data.SETOR, data.TEXTO_MENSAGEM, data.TITULO, arquivo?.name, arquivo?.id]);
        const selectQuery = `SELECT * FROM w_mensagens_prontas WHERE CODIGO = ? LIMIT 1`;
        let result = await instances_service_1.default.executeQuery(session.instance, selectQuery, [readyMessage.insertId]);
        result.map(m => {
            m.TITULO = decodeURI(m.TITULO);
            m.TEXTO_MENSAGEM = decodeURI(m.TEXTO_MENSAGEM);
            return m;
        });
        return result[0];
    }
    async getReadyMessages(session) {
        const isTI = session.sectorId === 3;
        const baseQuery = `
			SELECT *
			FROM w_mensagens_prontas
			${!isTI ? 'WHERE SETOR = ?' : ''}
			ORDER BY TITULO ASC
		`;
        const params = !isTI ? [session.sectorId] : [];
        const result = await instances_service_1.default.executeQuery(session.instance, baseQuery, params);
        result.map(m => {
            m.TITULO = decodeURI(m.TITULO);
            m.TEXTO_MENSAGEM = decodeURI(m.TEXTO_MENSAGEM);
            return m;
        });
        return result;
    }
    async updateReadyMessage(session, readyMessageId, data, file) {
        const fields = [];
        const values = [];
        if (data.TITULO)
            data.TITULO = encodeURI(data.TITULO);
        if (data.TEXTO_MENSAGEM)
            data.TEXTO_MENSAGEM = encodeURI(data.TEXTO_MENSAGEM);
        const fileData = await files_service_1.default.uploadFile({
            instance: session.instance,
            fileName: file.originalname,
            buffer: file.buffer,
            mimeType: file.mimetype,
            dirType: sdk_1.FileDirType.PUBLIC
        });
        for (const [key, value] of Object.entries({ ...data, ARQUIVO: fileData.name })) {
            if (typeof value === 'string') {
                fields.push(key);
                values.push(`'${value}'`);
            }
            ;
            if (typeof value === 'number') {
                fields.push(key);
                values.push(value);
            }
            ;
        }
        ;
        const updateQuery = `UPDATE w_mensagens_prontas
			SET ${fields.map((field, index) => `${field} = ${values[index]}`).join(', ')}, LAST_UPDATE = CURRENT_TIMESTAMP()
			WHERE CODIGO = ${readyMessageId};
			`;
        if (!fields.length || !values.length) {
            throw new Error("You must send at least one field to update.");
        }
        ;
        const selectQuery = `SELECT * FROM w_mensagens_prontas WHERE CODIGO = ${readyMessageId}`;
        await instances_service_1.default.executeQuery(session.instance, updateQuery, []);
        const updatedReadyMessage = instances_service_1.default.executeQuery(session.instance, updateQuery, [])
            .then(async () => {
            return await instances_service_1.default.executeQuery(session.instance, selectQuery, [])
                .then((res) => (0, class_transformer_1.plainToInstance)(ReadyMessage, res[0][0]))
                .catch((err) => {
                throw new Error(err);
            });
        })
            .catch((err) => {
            throw new Error(err);
        });
        return updatedReadyMessage;
    }
    async deleteReadyMessage(session, id) {
        const deleteQuery = `DELETE FROM w_mensagens_prontas WHERE CODIGO = ?;`;
        await instances_service_1.default.executeQuery(session.instance, deleteQuery, [id]);
    }
}
exports.default = new ReadyMessagesService();
