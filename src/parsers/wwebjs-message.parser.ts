import WAWebJS from "whatsapp-web.js";
import { FileDirType } from "@in.pulse-crm/sdk";
import { WppMessageStatus } from "@prisma/client";
import mime from "mime-types";
import ProcessingLogger from "../utils/processing-logger";
import CreateMessageDto from "../dtos/create-message.dto";
import prismaService from "../services/prisma.service";
import filesService from "../services/files.service";
import parseVCard from "../utils/parse-wwebjs-vcard";

class WWEBJSMessageParser {
	public static async parse(
		clientId: number,
		logger: ProcessingLogger,
		instance: string,
		message: WAWebJS.Message,
		skipParsingFile = false,
		skipParsingQuoted = false,
		isInternal = false,
		fromPhone: string | null = null
	) {
		logger.log(`Sanitizando mensagem...`);

		const parsedMessage: CreateMessageDto = {
			instance,
			wwebjsId: message.id._serialized,
			wwebjsIdStanza: message.id.id,
			from: `${(message.fromMe ? "me:" : "") + fromPhone || message.from.split("@")[0]}`,
			to: `${(message.fromMe ? "" : "me:") + message.to.split("@")[0]}`,
			body: message.type === "vcard" ? parseVCard(message.body) : message.body,
			type: message.type,
			timestamp: String(message.timestamp * 1000),
			sentAt: new Date(message.timestamp * 1000),
			status: WWEBJSMessageParser.getMessageStatus(message.ack),
			clientId
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

	private static async getQuotedId(logger: ProcessingLogger, message: WAWebJS.Message, isInternal: boolean) {
		logger.log(`Recuperando mensagem citada...`);
		const wwebjsQuotedMsg = await message.getQuotedMessage();

		if (!wwebjsQuotedMsg) {
			logger.log(`Mensagem citada não encontrada.`);
			return null;
		}

		logger.log(`Mensagem citada encontrada com ID: ${wwebjsQuotedMsg.id._serialized}`);
		if (isInternal) {
			logger.log(`Buscando mensagem citada no banco de dados como mensagem interna...`);
			const quotedMsg = await prismaService.internalMessage.findUnique({
				where: { wwebjsIdStanza: wwebjsQuotedMsg.id.id }
			});
			logger.log(`ID da mensagem citada no banco de dados: ${quotedMsg?.id}`);

			return quotedMsg?.id || null;
		}

		logger.log(`Buscando mensagem citada no banco de dados como mensagem externa...`);
		const quotedMsg = await prismaService.wppMessage.findUnique({
			where: { wwebjsIdStanza: wwebjsQuotedMsg.id.id }
		});
		logger.log(`ID da mensagem citada no banco de dados: ${quotedMsg?.id}`);

		return quotedMsg?.id || null;
	}

	private static async processMediaFile(logger: ProcessingLogger, instance: string, message: WAWebJS.Message) {
		const wwebjsFile = await message.downloadMedia();

		let buffer = Buffer.from(wwebjsFile.data, "base64");
		let fileName = wwebjsFile.filename;
		let mimeType = wwebjsFile.mimetype || "application/octet-stream";

		if (!fileName) {
			const ext = mime.extension(mimeType);
			fileName = `${message.type}.${ext}`;
		}

		logger.log(`Fazendo upload do arquivo de mídia: ${fileName}`);
		return await filesService.uploadFile({
			instance,
			buffer,
			fileName,
			dirType: FileDirType.PUBLIC,
			mimeType
		});
	}

	public static getMessageStatus(ack: WAWebJS.MessageAck | null | undefined): WppMessageStatus {
		switch (ack) {
			case WAWebJS.MessageAck.ACK_PENDING:
				return WppMessageStatus.PENDING;
			case WAWebJS.MessageAck.ACK_SERVER:
				return WppMessageStatus.SENT;
			case WAWebJS.MessageAck.ACK_DEVICE:
				return WppMessageStatus.RECEIVED;
			case WAWebJS.MessageAck.ACK_READ:
				return WppMessageStatus.READ;
			case WAWebJS.MessageAck.ACK_PLAYED:
				return WppMessageStatus.READ;
			default:
				return WppMessageStatus.ERROR;
		}
	}
}

export default WWEBJSMessageParser;
