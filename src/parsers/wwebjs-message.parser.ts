import WAWebJS from "whatsapp-web.js";
import { FileDirType } from "@in.pulse-crm/sdk";
import { WppMessageStatus } from "@prisma/client";
import mime from "mime-types";
import ProcessingLogger from "../utils/processing-logger";
import CreateMessageDto from "../dtos/create-message.dto";
import prismaService from "../services/prisma.service";
import filesService from "../services/files.service";

class WWEBJSMessageParser {
	public static async parse(
		logger: ProcessingLogger,
		instance: string,
		message: WAWebJS.Message,
		skipParsingFile = false,
		skipParsingQuoted = false
	) {
		logger.log(`Sanitizando mensagem...`);

		const parsedMessage: CreateMessageDto = {
			instance,
			wwebjsId: message.id._serialized,
			from: `${(message.fromMe ? "me:" : "") + message.from.split("@")[0]}`,
			to: `${(message.fromMe ? "" : "me:") + message.to.split("@")[0]}`,
			body: message.body,
			type: message.type,
			timestamp: String(message.timestamp * 1000),
			status: WWEBJSMessageParser.getMessageStatus(message.ack)
		};

		if (!skipParsingFile && message.hasMedia) {
			logger.log(
				`Mensagem contém mídia. Processando arquivo de mídia...`
			);
			const file = await WWEBJSMessageParser.processMediaFile(
				logger,
				instance,
				message
			);

			parsedMessage.fileId = file.id;
			parsedMessage.fileName = file.name;
			parsedMessage.fileType = file.mime_type;
			parsedMessage.fileSize = String(file.size);
			logger.log(
				`Arquivo de mídia processado com sucesso com ID: ${file.id}`
			);
		}

		if (!skipParsingQuoted && message.hasQuotedMsg) {
			logger.log(
				`Mensagem contém uma mensagem citada. Recuperando ID da citação...`
			);
			const quotedId = await WWEBJSMessageParser.getQuotedId(
				logger,
				message
			);
			parsedMessage.quotedId = quotedId;
			logger.log("Mensagem citada atribuída a mensagem com sucesso.");
		}

		logger.log(`Sanitização da mensagem concluída!`);
		return parsedMessage;
	}

	private static async getQuotedId(
		logger: ProcessingLogger,
		message: WAWebJS.Message
	) {
		logger.log(`Recuperando mensagem citada...`);
		const wwebjsQuotedMsg = await message.getQuotedMessage();

		if (!wwebjsQuotedMsg) {
			logger.log(`Mensagem citada não encontrada.`);
			return null;
		}

		logger.log(
			`Mensagem citada encontrada com ID: ${wwebjsQuotedMsg.id._serialized}`
		);
		logger.log(`Recuperando ID da mensagem citada no banco de dados...`);
		const quotedMsg = await prismaService.wppMessage.findUnique({
			where: { wwebjsId: wwebjsQuotedMsg.id._serialized }
		});
		logger.log(`ID da mensagem citada no banco de dados: ${quotedMsg?.id}`);

		return quotedMsg?.id || null;
	}

	private static async processMediaFile(
		logger: ProcessingLogger,
		instance: string,
		message: WAWebJS.Message
	) {
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

	public static getMessageStatus(ack: WAWebJS.MessageAck): WppMessageStatus {
		switch (ack) {
			case WAWebJS.MessageAck.ACK_PENDING:
				return "PENDING";
			case WAWebJS.MessageAck.ACK_DEVICE:
				return "RECEIVED";
			case WAWebJS.MessageAck.ACK_READ:
				return "READ";
			case WAWebJS.MessageAck.ACK_PLAYED:
				return "READ";
			case WAWebJS.MessageAck.ACK_SERVER:
				return "RECEIVED";
			default:
				return "ERROR";
		}
	}
}

export default WWEBJSMessageParser;
