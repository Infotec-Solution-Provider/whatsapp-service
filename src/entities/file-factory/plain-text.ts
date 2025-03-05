import { join } from "node:path";
import { createWriteStream } from "node:fs";
import FileFactory from "./index";

class PlainTextFactory implements FileFactory {
	public async createFile(
		path: string,
		fileName: string,
		content: string
	): Promise<void> {
		return new Promise((res, rej) => {
			const savePath = join(path, fileName);
			const stream = createWriteStream(savePath);

			stream.write(content);
			stream.end();

			stream.on("finish", () => {
				console.log(
					`${new Date().toLocaleString()} Arquivo criado: ${fileName}`
				);
				res();
			});
			stream.on("error", (err) => {
				console.log(
					`${new Date().toLocaleString()} Falha ao criar arquivo: ${fileName}`
				);
				rej(err);
			});
		});
	}
}

export default PlainTextFactory;
