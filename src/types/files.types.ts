import Stream from "node:stream";

export enum FileStorageType {
	LOCAL = "LOCAL",
	STORAGE_CLIENT = "STORAGE_CLIENT"
}

export enum FileDirType {
	PUBLIC = "public",
	TEMPORARY = "tmp",
	TEMPLATES = "templates"
}

export type FileContent =
	| string
	| NodeJS.ArrayBufferView
	| Iterable<string | NodeJS.ArrayBufferView>
	| AsyncIterable<string | NodeJS.ArrayBufferView>
	| Stream;

export interface SaveFileOptions {
	name: string;
	mimeType: string;
	content: FileContent;
}
