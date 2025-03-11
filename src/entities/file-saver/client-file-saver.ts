import FileSaver from "./file-saver";
import { FileDirType, SaveFileOptions } from "../../types/files.types";
import StoredFile from "../stored-file/stored-file";
import Logger from "../logger";

class ClientFileSaver implements FileSaver {
	public save(
		instance: string,
		dirType: FileDirType,
		file: SaveFileOptions,
		id?: string
	): Promise<StoredFile> {
		const debug = `instance: ${instance}, dirType: ${dirType}, fileName: ${file.name}, fileType: ${file.mimeType} | id: ${id || "random"}`;
		Logger.debug(`Save file props: `, debug);
		throw new Error("Method not implemented.");
	}
}

export default ClientFileSaver;
