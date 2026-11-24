import { execFile } from "node:child_process";

export const WABA_VOICE_NOTE_MIME_TYPE = "audio/ogg";

export function encodeWabaVoiceNote(source: Buffer, maxBytes: number): Promise<Buffer> {
	if (source.length === 0 || source.length > maxBytes) {
		return Promise.reject(new Error("Tamanho da gravação inválido para o WhatsApp oficial."));
	}

	return new Promise((resolve, reject) => {
		const encoder = execFile(process.env["FFMPEG_PATH"] || "ffmpeg", [
			"-hide_banner", "-loglevel", "error", "-xerror", "-abort_on", "empty_output",
			"-i", "pipe:0", "-map", "0:a:0", "-map_metadata", "-1",
			"-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-ar", "48000",
			"-application", "voip", "-f", "ogg", "pipe:1",
		], { encoding: "buffer", timeout: 30_000, maxBuffer: maxBytes, windowsHide: true }, (error, audio) => {
			if (error || audio.length === 0) {
				reject(new Error("Falha ao preparar a nota de voz em Ogg/Opus."));
				return;
			}
			resolve(audio);
		});
		// If FFmpeg exits early, the callback above reports the encoder error.
		encoder.stdin?.on("error", () => {});
		encoder.stdin?.end(source);
	});
}
