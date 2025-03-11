import { FileContent, FileDirType, FileStorageType } from "../../types/files.types";

abstract class StoredFile {
	abstract get id(): string;
	abstract get name(): string;
	abstract get ext(): string;
	abstract get mimeType(): string;
	abstract get size(): number;
	abstract get storageType(): FileStorageType;
	abstract get downloadURL(): string;
	abstract get dirType(): FileDirType;
	abstract get content(): Promise<FileContent>;
}

export default StoredFile;
