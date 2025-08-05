"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
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
                break;
            case "audio":
                fileUrl = data.audio.url;
                fileType = data.audio.mime_type;
                break;
            default:
                break;
        }
        console.log("fileUrl", fileUrl);
        console.log("fileType", fileType);
        if (fileUrl) {
            GUPSHUPMessageParser.processMediaFile(fileUrl);
        }
        return parsedMessage;
    }
    static async processMediaFile(url) {
        const response = await axios_1.default.get(url);
        console.log(response.data);
    }
}
exports.default = GUPSHUPMessageParser;
