import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";

function bufferToStream(buffer: Buffer) {
  const stream = new PassThrough();
  stream.end(buffer);
  return stream;
}

export async function convertMp3ToOgg(mp3Buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inputStream = bufferToStream(mp3Buffer);
    const outputStream = new PassThrough();

    const chunks: Buffer[] = [];

    outputStream.on("data", (chunk) => {
      chunks.push(chunk);
    });

    outputStream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    outputStream.on("error", (err) => {
      reject(err);
    });

    ffmpeg(inputStream)
      .inputFormat("mp3")
      .audioCodec("libopus")
      .format("ogg")
      .on("error", (err) => reject(err))
      .pipe(outputStream, { end: true });
  });
}
