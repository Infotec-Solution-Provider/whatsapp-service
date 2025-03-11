import { FileStorageType } from "../../types/files.types";
import FileSaver from "./file-saver";
import LocalFileSaver from "./local-file-saver";
import ClientFileSaver from "./client-file-saver";

export interface TFileSaverFactory {
	getSaver(type: FileStorageType): Promise<FileSaver>;
}

class FileSaverFactory {
	public async getSaver(type: FileStorageType): Promise<FileSaver> {
		switch (type) {
			case FileStorageType.LOCAL:
				return new LocalFileSaver();
			case FileStorageType.STORAGE_CLIENT:
				return new ClientFileSaver();
			default:
				throw new Error("Invalid file storage type");
		}
	}
}

export default new FileSaverFactory();
