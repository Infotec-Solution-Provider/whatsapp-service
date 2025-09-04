import axios from "axios";
import CreateMessageDto from "../dtos/create-message.dto";
import { GSMessageData, GSMessageStatusData } from "../types/gupshup-api.types";
import filesService from "../services/files.service";
import { FileDirType } from "@in.pulse-crm/sdk";
import { extension } from "mime-types";
import { WppMessageStatus } from "@prisma/client";
import { BadRequestError } from "@rgranatodutra/http-errors";
import parseGSVcard from "../utils/parse-gupshup-vcard";
import prismaService from "../services/prisma.service";

class GUPSHUPMessageParser {
	public static async parse(recipient: string, instance: string, data: GSMessageData) {
		const parsedMessage: CreateMessageDto = {
			instance,
			wabaId: data.id,
			from: data.from,
			to: `me:${recipient}`,
			type: data.type,
			timestamp: String(+data.timestamp * 1000),
			sentAt: new Date(+data.timestamp * 1000),
			status: "RECEIVED",
			body: ""
		};
		let fileUrl: string | null = null;
		let fileType: string | null = null;
		let fileName: string | null = null;

		if (data.context && data.context.id) {
			const quotedMsg = await prismaService.wppMessage.findUnique({ where: { wabaId: data.context.id } });

			quotedMsg && (parsedMessage.quotedId = quotedMsg.id);
		}

		if (data.context && data.context.forwarded === true) {
			parsedMessage.isForwarded = true;
		}

		if (data.context && data.context.frequently_forwarded === true) {
			parsedMessage.isForwarded = true;
		}

		switch (data.type) {
			case "text":
				parsedMessage.body = data.text.body;
				break;
			case "video":
				parsedMessage.body = data.video.caption || "";
				fileUrl = data.video.url;
				fileType = data.video.mime_type;
				break;
			case "image":
				parsedMessage.body = data.image.caption || "";
				fileUrl = data.image.url;
				fileType = data.image.mime_type;
				break;
			case "document":
				parsedMessage.body = data.document.caption || "";
				fileUrl = data.document.url;
				fileType = data.document.mime_type;
				fileName = data.document.filename;
				break;
			case "audio":
				fileUrl = data.audio.url;
				fileType = data.audio.mime_type;
				break;
			case "sticker":
				fileUrl = data.sticker.url;
				fileType = data.sticker.mime_type;
				break;
			case "contacts":
				parsedMessage.type = "vcard";

				if (data.contacts[0]) {
					parsedMessage.body = parseGSVcard(data.contacts[0]);
				}
				break;
			default:
				throw new Error("Unsupported message type");
		}

		if (fileUrl && fileType) {
			const file = await GUPSHUPMessageParser.processMediaFile(instance, fileUrl, fileType, fileName);

			parsedMessage.fileId = file.id;
			parsedMessage.fileName = file.name;
			parsedMessage.fileType = file.mime_type;
			parsedMessage.fileSize = String(file.size);
		}

		return parsedMessage;
	}

	public static async processMediaFile(instance: string, url: string, fileType: string, fileName?: string | null) {
		const response = await axios.get(url, { responseType: "arraybuffer" });
		const buffer = Buffer.from(response.data);

		if (!fileName) {
			const ext = extension(fileType) || "bin";
			fileName = fileType + "." + ext;
		}

		const file = await filesService.uploadFile({
			buffer,
			dirType: FileDirType.PUBLIC,
			fileName,
			instance,
			mimeType: fileType
		});

		return file;
	}

	public static parseStatus(data: GSMessageStatusData) {
		switch (data.status) {
			case "sent":
				return WppMessageStatus.SENT;
				break;
			case "delivered":
				return WppMessageStatus.RECEIVED;
				break;
			case "read":
				return WppMessageStatus.READ;
				break;
			case "enqueued":
				return WppMessageStatus.PENDING;
				break;
			case "failed":
				return WppMessageStatus.ERROR;
			default:
				throw new BadRequestError(`${data.status} status is not expected`);
		}
	}
}

export default GUPSHUPMessageParser;
