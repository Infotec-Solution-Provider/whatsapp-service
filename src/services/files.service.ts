import { File, FilesClient, FileDirType } from "../sdk-local";
import "dotenv/config";
import FormData from "form-data";
import { downloadCiagMedia, uploadCiagMedia } from "../integrations/ciag/media";

const DEFAULT_FILES_BASE_URL = "https://inpulse.infotecrs.inf.br";
const FILES_API_URL = process.env["FILES_API_URL"] || `${DEFAULT_FILES_BASE_URL}/api`;
const FILES_PUBLIC_BASE_URL = process.env["FILES_PUBLIC_BASE_URL"] || DEFAULT_FILES_BASE_URL;

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
	constructor(baseUrl: string) {
		super(baseUrl);
		const key = process.env["CIAG_FILES_SERVICE_KEY"];
		if (key) this.ax.defaults.headers.common["x-ciag-files-key"] = key;
	}
	public getPublicFileUrl(instance: string, publicId: string, baseUrl?: string): string {
		const origin = baseUrl || FILES_PUBLIC_BASE_URL;
		const normalizedOrigin = origin.endsWith("/") ? origin : `${origin}/`;

		return new URL(`public/${instance}/files/${publicId}`, normalizedOrigin).toString();
	}

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

	public override async uploadWabaMedia(instance: string, wabaMediaId: string): Promise<File> {
		const file = await downloadCiagMedia(instance, wabaMediaId, ({ buffer, mime, name }) => this.uploadFile({
			instance, dirType: FileDirType.MODELS, fileName: name, mimeType: mime, buffer
		}));
		return file ?? super.uploadWabaMedia(instance, wabaMediaId);
	}

	public async getWabaMedia(fileId: number, rejectedMediaId?: string, clientId?: number): Promise<string> {
		if (clientId !== undefined) {
			const media = await uploadCiagMedia(clientId, fileId, async (id) => ({
				file: await this.fetchFileMetadata(id), buffer: await this.fetchFile(id)
			}));
			if (media !== null) {
				if (media === rejectedMediaId) throw new Error("A Meta não renovou o identificador de mídia CIAG.");
				return media;
			}
		}
		const { data } = await this.ax.post<{ data: { mediaId: string } }>("/api/waba/get-media-id", {
			fileId,
			...(rejectedMediaId ? { rejectedMediaId } : {}),
		});

		const mediaId = data?.data?.mediaId;
		if (typeof mediaId !== "string" || !/^\d{1,255}$/.test(mediaId) || mediaId === rejectedMediaId) {
			throw new Error("O serviço de arquivos não retornou um novo identificador válido de mídia WABA.");
		}
		return mediaId;
	}
}

export default new ExtendedFilesClient(FILES_API_URL);
