import FileSaver from "./file-saver";
import StoredFile from "../stored-file/stored-file";
import { randomUUID } from "node:crypto";
import constants from "../../constants";
import { FileDirType, SaveFileOptions } from "../../types/files.types";
import { mkdir, writeFile } from "node:fs/promises";
import LocalStoredFile from "../stored-file/local-stored-file";
import path from "path";
import getFileSize from "../../utils/get-file-size";

class LocalFileSaver implements FileSaver {
	public async save(
		instance: string,
		dirType: FileDirType,
		{ name, content, mimeType }: SaveFileOptions,
		id?: string
	): Promise<StoredFile> {
		const pathTemplate = constants.APP_LOCAL_STORED_FILES_PATH_TEMPLATE;
		const fileDestination = pathTemplate
			.replace(":instance", instance)
			.replace(":type", dirType)
			.replace(":id", randomUUID());

		await mkdir(fileDestination, { recursive: true });
		await writeFile(path.join(fileDestination, name), content);

		const size = await getFileSize(content);
		id = id || randomUUID();

		return new LocalStoredFile({ instance, id, name, mimeType, size });
	}
}

export default LocalFileSaver;
