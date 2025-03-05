export default abstract class FileFactory {
	abstract createFile(
		path: string,
		fileName: string,
		content?: string
	): Promise<void>;
}
