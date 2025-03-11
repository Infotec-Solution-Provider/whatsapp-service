import archiver from "archiver";
import { Writable } from "stream";

class ZipCreator {
	public async fromPath(inputPath: string): Promise<Buffer> {
		const archive = archiver("zip", { zlib: { level: 9 } });
		const buffers: Buffer[] = [];

		const writableStream = new Writable({
			write(chunk, _encoding, callback) {
				buffers.push(chunk);
				callback();
			}
		});

		archive.on("error", (err) => {
			throw err;
		});

		archive.pipe(writableStream);
		archive.directory(inputPath, false);
		await archive.finalize();

		return Buffer.concat(buffers);
	}

	public async fromBuffers(
		files: { name?: string; buffer: Buffer }[]
	): Promise<Buffer> {
		const archive = archiver("zip", { zlib: { level: 9 } });
		const buffers: Buffer[] = [];

		const writableStream = new Writable({
			write(chunk, _encoding, callback) {
				buffers.push(chunk);
				callback();
			}
		});

		archive.on("error", (err) => {
			throw err;
		});

		archive.pipe(writableStream);
		files.forEach((file, index) =>
			archive.append(file.buffer, { name: file.name || String(index) })
		);
		await archive.finalize();

		return Buffer.concat(buffers);
	}
}

export default ZipCreator;
