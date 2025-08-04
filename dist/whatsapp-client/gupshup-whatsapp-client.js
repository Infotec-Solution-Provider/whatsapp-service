"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const GUP_URL = "https://api.gupshup.io";
class GupshupWhatsappClient {
    id;
    instance;
    name;
    phone;
    apiKey;
    appName;
    appId;
    api;
    constructor(id, instance, name, phone, apiKey, appName, appId) {
        this.id = id;
        this.instance = instance;
        this.name = name;
        this.phone = phone;
        this.apiKey = apiKey;
        this.appName = appName;
        this.appId = appId;
        this.api = axios_1.default.create({
            baseURL: GUP_URL,
            headers: {
                apikey: this.apiKey
            }
        });
    }
    async getProfilePictureUrl(_) {
        throw new Error("Method not implemented.");
    }
    async isValidWhatsapp(_) {
        throw new Error("Method not implemented.");
    }
    async sendMessage(options) {
        const data = new URLSearchParams();
        data.append("channel", "whatsapp");
        data.append("src.name", this.appName);
        data.append("source", this.phone);
        data.append("destination", options.to);
        if ("fileUrl" in options) {
            const urlKey = options.fileType === "image" ? "originalUrl" : "url";
            let message = {
                type: options.fileType || "document",
                [urlKey]: options.fileUrl
            };
            console.log(message);
            options.text && (message["caption"] = options.text);
            data.append("message", JSON.stringify(message));
        }
        else {
            if (!("text" in options)) {
                throw new Error("Text is required for text messages");
            }
            let message = {
                type: "text",
                text: options.text
            };
            data.append("message", JSON.stringify(message));
        }
        console.log(data);
        const response = await this.api
            .post("/wa/api/v1/msg", data, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            }
        })
            .catch((err) => {
            console.error(err.response.data);
            throw new Error("F");
        });
        const message = {
            instance: this.instance,
            from: `me:${this.phone}`,
            to: options.to,
            body: options.text || "",
            status: "PENDING",
            timestamp: Date.now().toString(),
            type: "fileUrl" in options ? options.fileType || "document" : "text",
            wabaId: response.data["messageId"] || null
        };
        if ("file" in options) {
            message.fileId = options.file.id;
            message.fileName = options.file.name;
            message.fileType = options.file.mime_type;
            message.fileSize = options.file.size?.toString() || null;
        }
        return message;
    }
    async sendTemplate(options) {
        const form = new FormData();
        form.append("channel", "whatsapp");
        form.append("src.name", this.appName);
        form.append("source", this.phone);
        form.append("destination", options.to);
        form.append("template", JSON.stringify({
            id: options.templateId,
            parameters: options.parameters || []
        }));
        const response = await this.api.post("/wa/api/v1/template/msg", form, {
            headers: {
                "Content-Type": "multipart/form-data"
            }
        });
        const text = options.templateText.replace(/{{(\d+)}}/g, (_, index) => {
            return options.parameters[parseInt(index, 10)] || "";
        });
        const message = {
            instance: this.instance,
            from: `me:${this.phone}`,
            to: options.to,
            body: text,
            status: "PENDING",
            timestamp: Date.now().toString(),
            type: "template",
            wabaId: response.data["messageId"] || null
        };
        return message;
    }
    async getTemplates() {
        const response = await this.api.get(`/wa/app/${this.appId}/template?templateStatus=APPROVED`);
        if (response.status !== 200) {
            throw new Error("Failed to fetch templates from Gupshup.");
        }
        return response.data.templates || [];
    }
}
exports.default = GupshupWhatsappClient;
