import StoredFile from "./stored-file";
import { StoredFileProps } from "./stored-file-props";
import constants from "../../constants";
import {
	FileContent,
	FileDirType,
	FileStorageType
} from "../../types/files.types";
import { readFile } from "node:fs/promises";

class LocalStoredFile implements StoredFile {
	private readonly _id: string;
	private readonly _name: string;
	private readonly _ext: string;
	private readonly _mimeType: string;
	private readonly _size: number;
	private readonly _instance: string;
	private readonly _dirType: FileDirType;

	constructor({ id, name, size, mimeType, instance, dir }: StoredFileProps) {
		this._id = id;
		this._name = name;
		this._ext = name.substring(0, name.lastIndexOf("."));
		this._mimeType = mimeType;
		this._size = size;
		this._instance = instance;
		this._dirType = dir;
	}

	public get id(): string {
		return this._id;
	}

	public get name(): string {
		return this._name;
	}

	public get ext(): string {
		return this._ext;
	}

	public get mimeType(): string {
		return this._mimeType;
	}

	public get size(): number {
		return this._size;
	}

	public get storageType(): FileStorageType {
		return FileStorageType.LOCAL;
	}

	public get dirType(): FileDirType {
		return this._dirType;
	}

	public get downloadURL(): string {
		const template = constants.APP_LOCAL_STORED_FILES_DOWNLOAD_URL_TEMPLATE;

		return template
			.replace(":instance", this._instance)
			.replace(":filename", this._name);
	}

	public get content(): Promise<FileContent> {
		const pathTemplate = constants.APP_LOCAL_STORED_FILES_PATH_TEMPLATE;
		const path = pathTemplate
			.replace(":instance", this._instance)
			.replace(":type", this._dirType)
			.replace(":id", this.id)
			.concat("\\" + this._name);

		return readFile(path);
	}
}

export default LocalStoredFile;
