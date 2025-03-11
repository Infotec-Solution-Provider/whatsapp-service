import { Stream } from "node:stream";
import { isArrayBufferView } from "util/types";
import { FileContent } from "../types/files.types";

async function getFileSize(content: FileContent): Promise<number> {
	if (typeof content === "string") {
		return Buffer.byteLength(content, "utf-8");
	}

	if (isArrayBufferView(content)) {
		return content.byteLength;
	}

	if (Symbol.iterator in Object(content)) {
		// Se for um Iterable, somamos os tamanhos dos itens
		let size = 0;
		for (const chunk of content as Iterable<
			string | NodeJS.ArrayBufferView
		>) {
			size +=
				typeof chunk === "string"
					? Buffer.byteLength(chunk, "utf-8")
					: chunk.byteLength;
		}
		return size;
	}

	if (Symbol.asyncIterator in Object(content)) {
		// Se for um AsyncIterable, iteramos assincronamente para calcular o tamanho
		let size = 0;
		for await (const chunk of content as AsyncIterable<
			string | NodeJS.ArrayBufferView
		>) {
			size +=
				typeof chunk === "string"
					? Buffer.byteLength(chunk, "utf-8")
					: chunk.byteLength;
		}
		return size;
	}

	// Stream: Captura os dados conforme são lidos
	let size = 0;
	await new Promise<void>((resolve, reject) => {
		const stream = content as Stream;
		stream.on("data", (chunk) => {
			size += Buffer.isBuffer(chunk)
				? chunk.length
				: Buffer.byteLength(chunk, "utf-8");
		});
		stream.on("end", resolve);
		stream.on("error", reject);
	});

	return size;
}

export default getFileSize;
