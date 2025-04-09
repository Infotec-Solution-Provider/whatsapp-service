import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rmdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

class OpusAudioConverter {

    public static async convert(file: Buffer): Promise<Buffer> {
        const tempPath = await mkdtemp(randomUUID());
        const savePath = path.join(tempPath, `audio.mp3`);

        const readableStream = new Readable({
            read() {
                this.push(file);
                this.push(null);
            },
        });

        const ffmpeg = spawn("ffmpeg", [
            "-i",
            "pipe:0",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
            savePath,
        ]);

        readableStream.pipe(ffmpeg.stdin);

        return new Promise((resolve, reject) => {
            ffmpeg.on("close", async (code: number) => {
                if (code === 0) {
                    const file = await readFile(savePath);
                    rmdir(tempPath, { recursive: true }).catch(() => { });
                    resolve(file);
                } else {
                    reject(
                        `Erro ao converter para Opus, código de saída: ${code}`
                    );
                }
            });

            ffmpeg.on("error", (err: any) => {
                reject(err);
            });
        });
    }
}

export default OpusAudioConverter;