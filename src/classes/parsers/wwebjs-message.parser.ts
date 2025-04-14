import WAWebJS from "whatsapp-web.js";
import OpusAudioConverter from "../opus-audio-converter";
import filesService from "../../services/files.service";
import { FileDirType } from "@in.pulse-crm/sdk";
import { WppMessage } from "@prisma/client";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";

class WWEBJSMessageParser {
	public static async parse(
		instance: string,
		message: WAWebJS.Message
	): Promise<WppMessage> {
		const parsedMessage: WppMessage = {
			instanceName: instance,
			id: message.id._serialized,
			from: message.from.split("@")[0]!,
			to: message.to,
			body: message.body,
			type: message.type,
			timestamp: String(message.timestamp * 1000),
			status: "PENDING",
			chatId: null,
			fileId: null,
			fileName: null,
			fileType: null,
			fileSize: null,
			quotedId: null
		};

		if (message.hasMedia) {
			const file = await WWEBJSMessageParser.processMediaFile(
				instance,
				message
			);

			parsedMessage.fileId = file.id;
			parsedMessage.fileName = file.name;
			parsedMessage.fileType = file.mime_type;
			parsedMessage.fileSize = String(file.size);
		}

		if (message.hasQuotedMsg) {
			const quotedId =
				await WWEBJSMessageParser.processQuotedMessage(message);
			parsedMessage.quotedId = quotedId;
		}

		return parsedMessage;
	}

	private static async processQuotedMessage(message: WAWebJS.Message) {
		const quotedMsg = await message.getQuotedMessage();
		if (!quotedMsg) {
			return null;
		}
		return quotedMsg.id._serialized;
	}

	private static async processMediaFile(
		instance: string,
		message: WAWebJS.Message
	) {
		try {
			const wwebjsFile = await message.downloadMedia();
			let buffer = Buffer.from(wwebjsFile.data, "base64");
			let fileName = wwebjsFile.filename || "file.bin";
			let mimeType = wwebjsFile.mimetype || "application/octet-stream";

			if (wwebjsFile.mimetype.includes("audio")) {
				buffer = await OpusAudioConverter.convert(buffer);
				fileName = fileName.replace(/\.[^/.]+$/, ".mp3");
				mimeType = "audio/mpeg";
			}

			return await filesService.uploadFile({
				instance,
				buffer,
				fileName,
				dirType: FileDirType.PUBLIC,
				mimeType
			});
		} catch (cause) {
			throw new Error(
				`Failed to process media file: ${sanitizeErrorMessage(cause)}`,
				{ cause }
			);
		}
	}
}

export default WWEBJSMessageParser;
