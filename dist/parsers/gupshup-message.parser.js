"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const files_service_1 = __importDefault(require("../services/files.service"));
const sdk_1 = require("@in.pulse-crm/sdk");
const mime_types_1 = require("mime-types");
const client_1 = require("@prisma/client");
const http_errors_1 = require("@rgranatodutra/http-errors");
class GUPSHUPMessageParser {
    static async parse(recipient, instance, data) {
        const parsedMessage = {
            instance,
            wabaId: data.id,
            from: data.from,
            to: `me:${recipient}`,
            type: data.type,
            timestamp: String(+data.timestamp * 1000),
            status: "RECEIVED",
            body: ""
        };
        let fileUrl = null;
        let fileType = null;
        let fileName = null;
        switch (data.type) {
            case "text":
                parsedMessage.body = data.text.body;
                break;
            case "video":
                parsedMessage.body = data.video.caption || "";
                fileUrl = data.video.url;
                fileType = data.video.mime_type;
                break;
            case "image":
                parsedMessage.body = data.image.caption || "";
                fileUrl = data.image.url;
                fileType = data.image.mime_type;
                break;
            case "document":
                parsedMessage.body = data.document.caption || "";
                fileUrl = data.document.url;
                fileType = data.document.mime_type;
                fileName = data.document.filename;
                break;
            case "audio":
                fileUrl = data.audio.url;
                fileType = data.audio.mime_type;
                break;
            default:
                break;
        }
        if (fileUrl && fileType) {
            const file = await GUPSHUPMessageParser.processMediaFile(instance, fileUrl, fileType, fileName);
            parsedMessage.fileId = file.id;
            parsedMessage.fileName = file.name;
            parsedMessage.fileType = file.mime_type;
            parsedMessage.fileSize = String(file.size);
        }
        return parsedMessage;
    }
    static async processMediaFile(instance, url, fileType, fileName) {
        const response = await axios_1.default.get(url, { responseType: "arraybuffer" });
        const buffer = Buffer.from(response.data);
        if (!fileName) {
            const ext = (0, mime_types_1.extension)(fileType) || "bin";
            fileName = fileType + "." + ext;
        }
        const file = await files_service_1.default.uploadFile({
            buffer,
            dirType: sdk_1.FileDirType.PUBLIC,
            fileName,
            instance,
            mimeType: fileType
        });
        return file;
    }
    static parseStatus(data) {
        switch (data.status) {
            case "sent":
                return client_1.WppMessageStatus.SENT;
                break;
            case "delivered":
                return client_1.WppMessageStatus.RECEIVED;
                break;
            case "read":
                return client_1.WppMessageStatus.READ;
                break;
            case "enqueued":
                return client_1.WppMessageStatus.SENT;
                break;
            default:
                throw new http_errors_1.BadRequestError(`${data.status} status is not expected`);
        }
    }
}
exports.default = GUPSHUPMessageParser;
