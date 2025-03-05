import pdf from "html-pdf";
import { join } from "node:path";
import FileFactory from "./index";

class PDFFactory implements FileFactory {
	public async createFile(
		path: string,
		fileName: string,
		content: string
	): Promise<void> {
		return new Promise((res, rej) => {
			const savePath = join(path, fileName);

			pdf.create(content, { format: "A4" }).toFile(
				savePath,
				(err, data) => {
					if (err) {
						console.log(
							`${new Date().toLocaleString()} Falha ao criar arquivo: ${fileName}`
						);
						rej(err);
					}
					console.log(
						`${new Date().toLocaleString()} Arquivo criado: `,
						data
					);
					res();
				}
			);
		});
	}
}

export default PDFFactory;
