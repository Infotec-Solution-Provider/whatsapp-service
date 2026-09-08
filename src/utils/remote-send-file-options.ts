import type { SendFileOptions, SendFileType } from "../types/whatsapp-instance.types";

type RemoteFileInput = Pick<SendFileOptions, "file" | "publicFileUrl" | "sendAsAudio" | "sendAsDocument">;

export function buildRemoteSendFileOptions(props: RemoteFileInput) {
	const sendAsDocument = props.sendAsDocument === true;
	let fileType: SendFileType = "document";
	if (!sendAsDocument) {
		const mimeType = props.file.mime_type;
		if (props.sendAsAudio === true || mimeType.startsWith("audio/")) fileType = "audio";
		else if (mimeType.startsWith("image/")) fileType = "image";
		else if (mimeType.startsWith("video/")) fileType = "video";
	}
	return {
		file: props.file,
		fileName: props.file.name,
		fileUrl: props.publicFileUrl,
		fileType,
		sendAsDocument,
		// The system uses true for voice notes; the remote API uses false for PTT.
		// Translate at the adapter boundary while preserving its public contract.
		sendAsAudio: props.sendAsAudio !== true
	};
}
