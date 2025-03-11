import { FileDirType } from "../../types/files.types";

export interface StoredFileProps {
	id: string;
	name: string;
	size: number;
	mimeType: string;
	instance: string;
	dir: FileDirType;
}
