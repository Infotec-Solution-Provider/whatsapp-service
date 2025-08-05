"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WABAContactsMessage = exports.WABADocumentMessage = exports.WABAImageMessage = exports.WABAVideoMessage = exports.WABAAudioMessage = exports.WABATextMessage = exports.WABAMessage = void 0;
const axios_1 = __importDefault(require("axios"));
class WABAMessage {
    id;
    from;
    timestamp;
    context;
    constructor(message) {
        this.id = message.id;
        this.from = message.from;
        this.timestamp = message.timestamp;
        this.context = message.context || null;
    }
    static fromData(message) {
        switch (message.type) {
            case "text":
                return new WABATextMessage(message);
            case "image":
                return new WABAImageMessage(message);
            case "video":
                return new WABAVideoMessage(message);
            case "audio":
                return new WABAAudioMessage(message);
            case "document":
                return new WABADocumentMessage(message);
            case "contacts":
                return new WABAContactsMessage(message);
            default:
                throw new Error("Invalid message type.");
        }
    }
    static async getMedia(mediaId, whatsappToken) {
        const requestURL = `https://graph.facebook.com/v16.0/${mediaId}`;
        const axiosConfig = {
            headers: {
                Authorization: `Bearer ${whatsappToken}`
            }
        };
        const fileResponse = await axios_1.default
            .get(requestURL, axiosConfig)
            .then((res) => res.data)
            .catch(() => new Error("failed to get media URL"));
        return fileResponse;
    }
}
exports.WABAMessage = WABAMessage;
class WABATextMessage extends WABAMessage {
    type = "text";
    text;
    constructor(message) {
        super(message);
        this.text = message.text;
    }
}
exports.WABATextMessage = WABATextMessage;
class WABAAudioMessage extends WABAMessage {
    type = "audio";
    audio;
    async getMedia(whatsappToken) {
        return await WABAMessage.getMedia(this.audio.id, whatsappToken);
    }
    constructor(message) {
        super(message);
        this.audio = message.audio;
    }
}
exports.WABAAudioMessage = WABAAudioMessage;
class WABAVideoMessage extends WABAMessage {
    type = "video";
    video;
    async getMedia(whatsappToken) {
        return await WABAMessage.getMedia(this.video.id, whatsappToken);
    }
    constructor(message) {
        super(message);
        this.video = message.video;
    }
}
exports.WABAVideoMessage = WABAVideoMessage;
class WABAImageMessage extends WABAMessage {
    type = "image";
    image;
    async getMedia(whatsappToken) {
        return await WABAMessage.getMedia(this.image.id, whatsappToken);
    }
    constructor(message) {
        super(message);
        this.image = message.image;
    }
}
exports.WABAImageMessage = WABAImageMessage;
class WABADocumentMessage extends WABAMessage {
    type = "document";
    document;
    async getMedia(whatsappToken) {
        return await WABAMessage.getMedia(this.document.id, whatsappToken);
    }
    constructor(message) {
        super(message);
        this.document = message.document;
    }
}
exports.WABADocumentMessage = WABADocumentMessage;
class WABAContactsMessage extends WABAMessage {
    type = "contacts";
    contacts;
    constructor(message) {
        super(message);
        this.contacts = message.contacts;
    }
}
exports.WABAContactsMessage = WABAContactsMessage;
