import WAWebJS from "whatsapp-web.js";
import OpusAudioConverter from "../opus-audio-converter";
import filesService from "../../services/files.service";
import { FileDirType } from "@in.pulse-crm/sdk";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import CreateMessageDto from "../../dtos/create-message.dto";
import prismaService from "../../services/prisma.service";

class WWEBJSMessageParser {
	public static async parse(instance: string, message: WAWebJS.Message) {
		const parsedMessage: CreateMessageDto = {
			instance,
			wwebjsId: message.id._serialized,
			from: message.from.split("@")[0]!,
			to: message.to,
			body: message.body,
			type: message.type,
			timestamp: String(message.timestamp * 1000),
			status: "PENDING"
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
			const quotedId = await WWEBJSMessageParser.getQuotedId(message);
			parsedMessage.quotedId = quotedId;
		}

		return parsedMessage;
	}

	private static async getQuotedId(message: WAWebJS.Message) {
		const wwebjsQuotedMsg = await message.getQuotedMessage();

		if (!wwebjsQuotedMsg) {
			return null;
		}

		const quotedMsg = await prismaService.wppMessage.findUnique({
			where: { wwebjsId: wwebjsQuotedMsg.id._serialized }
		});

		return quotedMsg?.id || null;
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
