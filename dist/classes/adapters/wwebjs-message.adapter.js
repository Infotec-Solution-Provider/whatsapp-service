"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const opus_audio_converter_1 = __importDefault(require("../opus-audio-converter"));
const files_service_1 = __importDefault(require("../../services/files.service"));
const sdk_1 = require("@in.pulse-crm/sdk");
class WWEBJSMessageAdapter {
    id;
    from;
    to;
    body;
    type;
    timestamp;
    instance;
    fileId = null;
    fileName = null;
    fileType = null;
    fileSize = null;
    quoteId = null;
    static async parse(instance, message) {
        const adaptedMessage = new WWEBJSMessageAdapter(instance, message);
        if (message.hasMedia) {
            const savedFile = await WWEBJSMessageAdapter.saveFile(instance, message);
            adaptedMessage.setFile(savedFile);
        }
        if (message.hasQuotedMsg) {
            const quotedMessage = await message.getQuotedMessage();
            adaptedMessage.setQuoteId(quotedMessage.id._serialized);
        }
        return adaptedMessage;
    }
    constructor(instance, message) {
        this.id = message.id._serialized;
        this.from = message.from;
        this.to = message.to;
        this.body = message.body;
        this.type = message.type;
        this.timestamp = BigInt(message.timestamp * 1000);
        this.instance = instance;
    }
    setFile(file) {
        this.fileId = file.id;
        this.fileName = file.name;
        this.fileType = file.mime_type;
        this.fileSize = file.size;
    }
    setQuoteId(quoteId) {
        this.quoteId = quoteId;
    }
    static async saveFile(instance, message) {
        const wwebjsFile = await message.downloadMedia();
        let buffer = Buffer.from(wwebjsFile.data, "base64");
        let fileName = wwebjsFile.filename || "file.bin";
        let mimeType = wwebjsFile.mimetype || "application/octet-stream";
        if (wwebjsFile.mimetype.includes("audio")) {
            buffer = await opus_audio_converter_1.default.convert(buffer);
            fileName = fileName.replace(/\.[^/.]+$/, ".mp3");
            mimeType = "audio/mpeg";
        }
        const savedFile = await files_service_1.default.uploadFile({
            instance,
            buffer,
            fileName,
            dirType: sdk_1.FileDirType.PUBLIC,
            mimeType
        });
        return savedFile;
    }
}
exports.default = WWEBJSMessageAdapter;
