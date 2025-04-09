
import WAWebJS from "whatsapp-web.js";

import MessageAdapter from "./message.adapter";
import OpusAudioConverter from "../opus-audio-converter";
import filesService from "../../services/files.service";
import { File, FileDirType } from "@in.pulse-crm/sdk";

class WWEBJSMessageAdapter implements MessageAdapter {
    public readonly id: string;
    public readonly from: string;
    public readonly to: string;
    public readonly body: string;
    public readonly type: string;
    public readonly timestamp: bigint;
    public readonly instance: string;
    public fileId: number | null = null;
    public fileName: string | null = null;
    public fileType: string | null = null;
    public fileSize: number | null = null;
    public quoteId: string | null = null;

    public static async parse(instance: string, message: WAWebJS.Message): Promise<WWEBJSMessageAdapter> {
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

    constructor(instance: string, message: WAWebJS.Message) {
        this.id = message.id._serialized;
        this.from = message.from;
        this.to = message.to;
        this.body = message.body;
        this.type = message.type;
        this.timestamp = BigInt(message.timestamp * 1000);
        this.instance = instance;
    }

    private setFile(file: File) {
        this.fileId = file.id;
        this.fileName = file.name;
        this.fileType = file.mime_type;
        this.fileSize = file.size;
    }

    private setQuoteId(quoteId: string) {
        this.quoteId = quoteId;
    }

    private static async saveFile(instance: string, message: WAWebJS.Message) {
        const wwebjsFile = await message.downloadMedia();
        let buffer = Buffer.from(wwebjsFile.data, "base64");
        let fileName = wwebjsFile.filename || "file.bin";
        let mimeType = wwebjsFile.mimetype || "application/octet-stream";

        if (wwebjsFile.mimetype.includes("audio")) {
            buffer = await OpusAudioConverter.convert(buffer);
            fileName = fileName.replace(/\.[^/.]+$/, ".mp3");
            mimeType = "audio/mpeg";
        }

        const savedFile = await filesService.uploadFile({
            instance,
            buffer,
            fileName,
            dirType: FileDirType.PUBLIC,
            mimeType
        });

        return savedFile;
    }
}

export default WWEBJSMessageAdapter;
