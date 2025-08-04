"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const whatsapp_web_js_1 = __importDefault(require("whatsapp-web.js"));
const sdk_1 = require("@in.pulse-crm/sdk");
const client_1 = require("@prisma/client");
const mime_types_1 = __importDefault(require("mime-types"));
const prisma_service_1 = __importDefault(require("../services/prisma.service"));
const files_service_1 = __importDefault(require("../services/files.service"));
class WWEBJSMessageParser {
    static async parse(logger, instance, message, skipParsingFile = false, skipParsingQuoted = false, isInternal = false) {
        logger.log(`Sanitizando mensagem...`);
        const parsedMessage = {
            instance,
            wwebjsId: message.id._serialized,
            wwebjsIdStanza: message.id.id,
            from: `${(message.fromMe ? "me:" : "") + message.from.split("@")[0]}`,
            to: `${(message.fromMe ? "" : "me:") + message.to.split("@")[0]}`,
            body: message.body,
            type: message.type,
            timestamp: String(message.timestamp * 1000),
            status: WWEBJSMessageParser.getMessageStatus(message.ack),
            isForwarded: true
        };
        if (!skipParsingFile && message.hasMedia) {
            logger.log(`Mensagem contém mídia. Processando arquivo de mídia...`);
            const file = await WWEBJSMessageParser.processMediaFile(logger, instance, message);
            parsedMessage.fileId = file.id;
            parsedMessage.fileName = file.name;
            parsedMessage.fileType = file.mime_type;
            parsedMessage.fileSize = String(file.size);
            logger.log(`Arquivo de mídia processado com sucesso com ID: ${file.id}`);
        }
        if (!skipParsingQuoted && message.hasQuotedMsg) {
            logger.log(`Mensagem contém uma mensagem citada. Recuperando ID da citação...`);
            const quotedId = await WWEBJSMessageParser.getQuotedId(logger, message, isInternal);
            parsedMessage.quotedId = quotedId;
            logger.log("Mensagem citada atribuída a mensagem com sucesso.");
        }
        logger.log(`Sanitização da mensagem concluída!`);
        return parsedMessage;
    }
    static async getQuotedId(logger, message, isInternal) {
        logger.log(`Recuperando mensagem citada...`);
        const wwebjsQuotedMsg = await message.getQuotedMessage();
        if (!wwebjsQuotedMsg) {
            logger.log(`Mensagem citada não encontrada.`);
            return null;
        }
        logger.log(`Mensagem citada encontrada com ID: ${wwebjsQuotedMsg.id._serialized}`);
        if (isInternal) {
            logger.log(`Buscando mensagem citada no banco de dados como mensagem interna...`);
            const quotedMsg = await prisma_service_1.default.internalMessage.findUnique({
                where: { wwebjsIdStanza: wwebjsQuotedMsg.id.id }
            });
            logger.log(`ID da mensagem citada no banco de dados: ${quotedMsg?.id}`);
            return quotedMsg?.id || null;
        }
        logger.log(`Buscando mensagem citada no banco de dados como mensagem externa...`);
        const quotedMsg = await prisma_service_1.default.wppMessage.findUnique({
            where: { wwebjsIdStanza: wwebjsQuotedMsg.id.id }
        });
        logger.log(`ID da mensagem citada no banco de dados: ${quotedMsg?.id}`);
        return quotedMsg?.id || null;
    }
    static async processMediaFile(logger, instance, message) {
        const wwebjsFile = await message.downloadMedia();
        let buffer = Buffer.from(wwebjsFile.data, "base64");
        let fileName = wwebjsFile.filename;
        let mimeType = wwebjsFile.mimetype || "application/octet-stream";
        if (!fileName) {
            const ext = mime_types_1.default.extension(mimeType);
            fileName = `${message.type}.${ext}`;
        }
        logger.log(`Fazendo upload do arquivo de mídia: ${fileName}`);
        return await files_service_1.default.uploadFile({
            instance,
            buffer,
            fileName,
            dirType: sdk_1.FileDirType.PUBLIC,
            mimeType
        });
    }
    static getMessageStatus(ack) {
        switch (ack) {
            case whatsapp_web_js_1.default.MessageAck.ACK_PENDING:
                return client_1.WppMessageStatus.PENDING;
            case whatsapp_web_js_1.default.MessageAck.ACK_SERVER:
                return client_1.WppMessageStatus.SENT;
            case whatsapp_web_js_1.default.MessageAck.ACK_DEVICE:
                return client_1.WppMessageStatus.RECEIVED;
            case whatsapp_web_js_1.default.MessageAck.ACK_READ:
                return client_1.WppMessageStatus.READ;
            case whatsapp_web_js_1.default.MessageAck.ACK_PLAYED:
                return client_1.WppMessageStatus.READ;
            default:
                return client_1.WppMessageStatus.ERROR;
        }
    }
}
exports.default = WWEBJSMessageParser;
