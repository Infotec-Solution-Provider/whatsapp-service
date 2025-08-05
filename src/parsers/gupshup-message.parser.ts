import axios from "axios";
import CreateMessageDto from "../dtos/create-message.dto";
import { GSMessageData } from "../types/gupshup-api.types";

class GUPSHUPMessageParser {
	public static async parse(
		recipient: string,
		instance: string,
		data: GSMessageData
	) {
		const parsedMessage: CreateMessageDto = {
			instance,
			wabaId: data.id,
			from: data.from,
			to: `me:${recipient}`,
			type: data.type,
			timestamp: String(+data.timestamp * 1000),
			status: "RECEIVED",
			body: ""
		};

		let fileUrl: string | null = null;
		let fileType: string | null = null;

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
				break;
			case "audio":
				fileUrl = data.audio.url;
				fileType = data.audio.mime_type;
				break;
			default:
				break;
		}

		console.log("fileUrl", fileUrl);
		console.log("fileType", fileType);

		return parsedMessage;
	}

	public static async processMediaFile(url: string) {
		const response = await axios.get(url);

		console.log(response.data);
	}
}

export default GUPSHUPMessageParser;
