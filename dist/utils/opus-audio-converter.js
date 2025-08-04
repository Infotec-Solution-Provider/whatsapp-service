"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const node_stream_1 = require("node:stream");
class OpusAudioConverter {
    static async convert(file) {
        const tempPath = await (0, promises_1.mkdtemp)((0, node_crypto_1.randomUUID)());
        const savePath = node_path_1.default.join(tempPath, `audio.mp3`);
        const readableStream = new node_stream_1.Readable({
            read() {
                this.push(file);
                this.push(null);
            }
        });
        const ffmpeg = (0, node_child_process_1.spawn)("ffmpeg", [
            "-i",
            "pipe:0",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
            savePath
        ]);
        readableStream.pipe(ffmpeg.stdin);
        return new Promise((resolve, reject) => {
            ffmpeg.on("close", async (code) => {
                if (code === 0) {
                    const file = await (0, promises_1.readFile)(savePath);
                    (0, promises_1.rmdir)(tempPath, { recursive: true }).catch(() => { });
                    resolve(file);
                }
                else {
                    reject(`Erro ao converter para Opus, código de saída: ${code}`);
                }
            });
            ffmpeg.on("error", (err) => {
                reject(err);
            });
        });
    }
}
exports.default = OpusAudioConverter;
