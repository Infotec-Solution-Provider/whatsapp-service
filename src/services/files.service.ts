import { File, FilesClient, FileDirType } from "@in.pulse-crm/sdk";
import "dotenv/config";
import FormData from "form-data";

const FILES_API_URL = process.env["FILES_API_URL"] || "http://localhost:8003/api";

interface ExtendedUploadFileOptions {
	instance: string;
	dirType: FileDirType;
	fileName: string;
	buffer: Buffer;
	mimeType: string;
	traceId?: string;
	contentHash?: string;
}

class ExtendedFilesClient extends FilesClient {
	public override async uploadFile(props: ExtendedUploadFileOptions): Promise<File> {
		const form = new FormData();
		form.append("instance", props.instance);
		form.append("dirType", props.dirType);
		if (props.contentHash) {
			form.append("contentHash", props.contentHash);
		}
		if (props.traceId) {
			form.append("traceId", props.traceId);
		}

		form.append("file", props.buffer, {
			filename: props.fileName,
			contentType: props.mimeType,
		});

		const response = await this.ax.post<{ data: File }>("/api/files", form, {
			headers: {
				...form.getHeaders(),
				...(props.traceId ? { "x-upload-trace-id": props.traceId } : {}),
			},
			timeout: 300000,
			maxBodyLength: Infinity,
			maxContentLength: Infinity,
		});

		return response.data.data;
	}

	public async getWabaMedia(fileId: number): Promise<string> {
		const { data } = await this.ax.post<{ data: { mediaId: string } }>("/api/waba/get-media-id", {
			fileId,
		});

		return data.data.mediaId;
	}
}

export default new ExtendedFilesClient(FILES_API_URL);