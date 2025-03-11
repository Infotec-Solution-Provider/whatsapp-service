import StoredFile from "../stored-file/stored-file";
import { FileDirType, SaveFileOptions } from "../../types/files.types";

abstract class FileSaver {
	abstract save(
		instance: string,
		dirType: FileDirType,
		file: SaveFileOptions,
		id?: string
	): Promise<StoredFile>;
}

export default FileSaver;
