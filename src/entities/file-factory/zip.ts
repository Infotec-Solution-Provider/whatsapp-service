import { createWriteStream } from "node:fs";
import archiver from "archiver";

class ZipFactory {
	public async createFile(
		inputPath: string,
		outputPath: string
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const output = createWriteStream(outputPath);
			const archive = archiver("zip", { zlib: { level: 9 } });

			output.on("close", () => {
				resolve();
			});

			output.on("error", (err) => {
				console.error(err);
				reject(err);
			});
			archive.on("error", () =>
				reject(new Error("Archiver falhou ao compactar o arquivo"))
			);

			archive.pipe(output);
			archive.directory(inputPath, false);
			archive.finalize();
		});
	}
}

export default ZipFactory;
