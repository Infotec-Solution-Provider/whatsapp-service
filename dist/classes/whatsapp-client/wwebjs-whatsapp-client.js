"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const whatsapp_web_js_1 = __importStar(require("whatsapp-web.js"));
const utils_1 = require("@in.pulse-crm/utils");
const node_crypto_1 = require("node:crypto");
const socket_service_1 = __importDefault(require("../../services/socket.service"));
const sdk_1 = require("@in.pulse-crm/sdk");
const wwebjs_message_parser_1 = __importDefault(require("../parsers/wwebjs-message.parser"));
const messages_service_1 = __importDefault(require("../../services/messages.service"));
const processing_logger_1 = __importDefault(require("../processing-logger"));
const messages_distribution_service_1 = __importDefault(require("../../services/messages-distribution.service"));
const prisma_service_1 = __importDefault(require("../../services/prisma.service"));
const PUPPETEER_ARGS = {
    headless: true,
    args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu"
    ]
};
const IGNORED_MESSAGE_TYPES = process.env["WWEBJS_IGNORED_MESSAGE_TYPES"]?.split(",") || [];
class WWEBJSWhatsappClient {
    id;
    instance;
    name;
    wwebjs;
    isReady = false;
    constructor(id, instance, name) {
        this.id = id;
        this.instance = instance;
        this.name = name;
        this.wwebjs = new whatsapp_web_js_1.Client({
            authStrategy: new whatsapp_web_js_1.LocalAuth({
                clientId: `${this.instance}_${this.name}`
            }),
            puppeteer: {
                ...PUPPETEER_ARGS,
                browserURL: process.env["WWEBJS_BROWSER_PATH"]
            }
        });
        this.buildEvents(instance, id);
        this.wwebjs.initialize().catch((err) => {
            utils_1.Logger.error(`Error initializing client: ${(0, utils_1.sanitizeErrorMessage)(err)}`);
        });
    }
    get phone() {
        return this.wwebjs.info.wid.user;
    }
    buildEvents(instance, id) {
        const instanceAndId = `${instance}:${id}`;
        this.wwebjs.on("change_state", (s) => {
            utils_1.Logger.info(`[${instanceAndId}] State changed: ${s}`);
        });
        this.wwebjs.on("disconnected", (r) => {
            utils_1.Logger.info(`[${instanceAndId}] Disconnected: ${r}`);
        });
        this.wwebjs.on("auth_failure", (m) => {
            utils_1.Logger.info(`[${instanceAndId}] Auth failure: ${m}`);
        });
        this.wwebjs.on("loading_screen", (p, m) => {
            utils_1.Logger.info(`[${instanceAndId}] Loading: ${p}% | ${m}`);
        });
        this.wwebjs.on("qr", this.handleQr.bind(this));
        this.wwebjs.on("authenticated", this.handleAuth.bind(this));
        this.wwebjs.on("ready", this.handleReady.bind(this));
        this.wwebjs.on("message", this.handleMessage.bind(this));
        this.wwebjs.on("message_edit", this.handleMessageEdit.bind(this));
        this.wwebjs.on("message_ack", this.handleMessageAck.bind(this));
        this.wwebjs.on("message_reaction", this.handleMessageReaction.bind(this));
        this.wwebjs.on("message_revoke_everyone", this.handleMessageRevoked.bind(this));
    }
    handleQr(qr) {
        utils_1.Logger.debug(`QR generated for ${this.instance} - ${this.name}`);
        const room = `${this.instance}:${1}:admin`;
        socket_service_1.default.emit(sdk_1.SocketEventType.WwebjsQr, room, {
            qr,
            phone: this.name
        });
    }
    handleAuth() {
        utils_1.Logger.debug(`Authenticated for ${this.instance} - ${this.name}`);
        const room = `${this.instance}:${1}:admin`;
        socket_service_1.default.emit(sdk_1.SocketEventType.WwebjsAuth, room, {
            phone: this.name,
            success: true
        });
    }
    async handleReady() {
        utils_1.Logger.info(`[${this.instance} - ${this.name}] Ready!`);
        this.isReady = true;
        await prisma_service_1.default.wppClient.update({
            where: {
                id: this.id
            },
            data: {
                phone: this.wwebjs.info.wid.user
            }
        });
    }
    async handleMessage(msg) {
        utils_1.Logger.debug("Message received: " + msg.id._serialized);
        const process = new processing_logger_1.default(this.instance, "wwebjs-message-receive", msg.id._serialized, msg);
        try {
            if (msg.fromMe) {
                return process.log("Message ignored: it is from me.");
            }
            if (msg.isStatus) {
                return process.log("Message ignored: it is status.");
            }
            if (IGNORED_MESSAGE_TYPES.includes(msg.type)) {
                return process.log("Message ignored: it is ignored type.");
            }
            if (msg.from === "status@broadcast") {
                return process.log("Message ignored: it is broadcast.");
            }
            if (!msg.from.includes("@c.us")) {
                return process.log("Message ignored: it is not a contact.");
            }
            const parsedMsg = await wwebjs_message_parser_1.default.parse(process, this.instance, msg);
            process.log(`Message is successfully parsed!`, parsedMsg);
            const savedMsg = await messages_service_1.default.insertMessage(parsedMsg);
            process.log(`Message is successfully saved!`);
            messages_distribution_service_1.default.processMessage(this.instance, this.id, savedMsg);
            process.log(`Message sent to distribution service!`);
            process.success(savedMsg);
        }
        catch (err) {
            process.log(`Error while processing message: ${(0, utils_1.sanitizeErrorMessage)(err)}`);
            process.failed(err);
        }
    }
    handleMessageEdit(message) {
        utils_1.Logger.debug("Message edit: " + message.id._serialized);
    }
    handleMessageAck({ id }, ack) {
        utils_1.Logger.info("Message ack: " + ack + " | " + id._serialized + "!");
        const status = wwebjs_message_parser_1.default.getMessageStatus(ack);
        messages_distribution_service_1.default.processMessageStatus("wwebjs", id._serialized, status);
    }
    handleMessageReaction(_reaction) { }
    handleMessageRevoked({ id }) {
        utils_1.Logger.info("Message revoked! " + id._serialized);
    }
    async getProfilePictureUrl(phone) {
        return await this.wwebjs
            .getProfilePicUrl(phone + "@c.us")
            .then((url) => url)
            .catch(() => null);
    }
    async isValidWhatsapp(phone) {
        return await this.wwebjs.isRegisteredUser(phone + "@c.us");
    }
    async getValidWhatsapp(phone) {
        const result = await this.wwebjs.getNumberId(phone);
        return result ? result.user : null;
    }
    async sendMessage(options) {
        const id = (0, node_crypto_1.randomUUID)();
        const process = new processing_logger_1.default(this.instance, "wwebjs-send-message", id, options);
        process.log("Iniciando envio de mensagem.", options);
        options.to = `${options.to}@c.us`;
        const { to, quotedId, text } = options;
        let content = null;
        const params = {};
        quotedId && (params.quotedMessageId = quotedId);
        if ("fileUrl" in options) {
            process.log("Preparando conteúdo da mensagem como mídia.");
            options.sendAsAudio && (params.sendAudioAsVoice = true);
            options.sendAsDocument && (params.sendMediaAsDocument = true);
            text && (params.caption = text);
            content = await whatsapp_web_js_1.default.MessageMedia.fromUrl(options.fileUrl, {
                unsafeMime: true,
                filename: options.fileName
            });
        }
        else {
            process.log("Preparando conteúdo da mensagem como texto.");
            content = text;
        }
        process.log("Conteúdo da mensagem pronto!");
        try {
            process.log("Enviando mensagem.", options);
            const sentMsg = await this.wwebjs.sendMessage(to, content, params);
            process.log("Mensagem enviada com sucesso.", sentMsg);
            const parsedMsg = await wwebjs_message_parser_1.default.parse(process, this.instance, sentMsg, true, true);
            process.success(parsedMsg);
            return parsedMsg;
        }
        catch (err) {
            process.log("Erro ao enviar mensagem.", err);
            process.failed(err);
            throw err;
        }
    }
}
exports.default = WWEBJSWhatsappClient;
