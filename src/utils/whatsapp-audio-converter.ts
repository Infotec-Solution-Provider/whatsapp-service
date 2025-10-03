import Ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { Logger } from "@in.pulse-crm/utils";

export interface WhatsappConvertedAudio {
	buffer: Buffer;
	mimeType: string;
	extension: string;
	size: number;
	duration: number | null;
}

const TARGET_FORMAT = "mp3";
const TARGET_MIMETYPE = "audio/mpeg";
const TARGET_AUDIOBITRATE = "64k"; // 32k–64k é bom para voz
const TARGET_AUDIOFREQUENCY = 44100; // padrão universal (compatível com Android/iOS)
const TARGET_CHANNELS = 1; // mono é suficiente para voz
const TARGET_CODEC = "libmp3lame";

class WhatsappAudioConverter {
	/**
	 * Converte um áudio em memória (Buffer) para um formato de alta compatibilidade (default: mp3).
	 * @param inputBuffer Buffer original
	 * @param originalMime Mime-Type original (ex: audio/ogg, audio/aac, audio/mpeg)
	 * @param options Opções de conversão
	 */
	static async convertToCompatible(inputBuffer: Buffer, originalMime: string): Promise<WhatsappConvertedAudio> {
		if (!inputBuffer?.length) throw new Error("Buffer de entrada vazio.");

		// Ensure base temp subfolders
		const baseDir = join(tmpdir(), "audios");
		const inDir = join(baseDir, "in");
		const outDir = join(baseDir, "out");
		await fs.mkdir(inDir, { recursive: true });
		await fs.mkdir(outDir, { recursive: true });

		let duration: number | null = null;
		const ext = this.inferExtension(originalMime) || ".tmp";
		const tmpInPath = await this.writeTempFile(inputBuffer, ext);
		const tmpOutPath = join(outDir, `${randomUUID()}.${TARGET_FORMAT}`);

		// ffprobe para diagnosticar entrada
		let probeInfo: any = null;
		try {
			probeInfo = await this.ffprobeSafe(tmpInPath);
		} catch {
			// continua – relatamos depois
		}

		const stderrLines: string[] = [];
		try {
			await new Promise<void>((resolve, reject) => {
				Ffmpeg(tmpInPath)
					.noVideo()
					.audioChannels(TARGET_CHANNELS)
					.audioFrequency(TARGET_AUDIOFREQUENCY)
					.audioCodec(TARGET_CODEC)
					.audioBitrate(TARGET_AUDIOBITRATE)
					.format(TARGET_FORMAT)
					.outputOptions([
						"-vn", // remove qualquer stream de vídeo
						"-application",
						"voip" // otimizado para fala, compatível com WA
					])
					.on("stderr", (line) => stderrLines.push(line))
					.on("error", (err) => {
						const streams =
							probeInfo?.streams?.map(
								(s: any) => `${s.codec_type}/${s.codec_name}/${s.sample_rate || ""}`
							) || [];
						err.message =
							`Falha na conversão (${err.message}).\n` +
							`Input: ${tmpInPath}\nOutput: ${tmpOutPath}\n` +
							`Original MIME: ${originalMime}\n` +
							`Probe streams: ${streams.join(", ") || "N/A"}\n` +
							`ffmpeg stderr:\n${stderrLines.join("\n")}`;
						reject(err);
					})
					.on("end", () => {
						Ffmpeg.ffprobe(tmpOutPath, (err, data) => {
							console.log("FFPROBE RESULT", { err, data });
							duration = data?.format?.duration || null;
							resolve();
						});
					})
					.save(tmpOutPath);
			});

			const outputBuffer = await fs.readFile(tmpOutPath);

			return {
				buffer: outputBuffer,
				mimeType: TARGET_MIMETYPE,
				extension: TARGET_FORMAT,
				size: outputBuffer.length,
				duration
			};
		} finally {
			console.log("KEEP_TEMP_AUDIO", process.env["KEEP_TEMP_AUDIO"]);
			if (process.env["KEEP_TEMP_AUDIO"] !== "true") {
				Logger.debug("Removing temp audio files", { tmpInPath, tmpOutPath });
				await this.safeUnlink(tmpInPath);
				await this.safeUnlink(tmpOutPath);
			}
		}
	}

	private static ffprobeSafe(path: string): Promise<any> {
		return new Promise((resolve, reject) => {
			Ffmpeg.ffprobe(path, (err, data) => {
				if (err) return reject(err);
				resolve(data);
			});
		});
	}

	private static async writeTempFile(buffer: Buffer, extension: string): Promise<string> {
		const dir = join(tmpdir(), "audios", "in");
		await fs.mkdir(dir, { recursive: true });
		const filePath = join(dir, `${randomUUID()}${extension.startsWith(".") ? extension : "." + extension}`);
		await fs.writeFile(filePath, buffer);
		return filePath;
	}

	private static async safeUnlink(path: string) {
		try {
			await fs.unlink(path);
		} catch {}
	}

	private static inferExtension(mime: string): string | undefined {
		if (!mime) return;
		const map: Record<string, string> = {
			"audio/mpeg": ".mp3",
			"audio/mp3": ".mp3",
			"audio/wav": ".wav",
			"audio/x-wav": ".wav",
			"audio/ogg": ".ogg",
			"audio/opus": ".opus",
			"audio/aac": ".aac",
			"audio/x-m4a": ".m4a",
			"audio/mp4": ".m4a",
			"video/3gpp": ".3gp",
			"audio/amr": ".amr"
		};
		return map[mime];
	}
}

export default WhatsappAudioConverter;
