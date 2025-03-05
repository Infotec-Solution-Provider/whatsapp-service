import FileFactory from "./index";
import PDFFactory from "./pdf";
import PlainTextFactory from "./plain-text";

class FilesFactory {
	public static getFactory(format: string): FileFactory {
		switch (format) {
			case "pdf":
				return new PDFFactory();
			default:
				return new PlainTextFactory();
		}
	}
}

export default FilesFactory;
