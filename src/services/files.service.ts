import { FilesClient } from "@in.pulse-crm/sdk";
import "dotenv/config";

const FILES_API_URL = process.env["FILES_API_URL"] || "http://localhost:8003/api";

class ExtendedFilesClient extends FilesClient {
	public async getWabaMedia(fileId: number): Promise<string> {
		const { data } = await this.ax.post<{ data: { mediaId: string } }>("/api/waba/get-media-id", {
			fileId,
		});

		return data.data.mediaId;
	}
}

export default new ExtendedFilesClient(FILES_API_URL);