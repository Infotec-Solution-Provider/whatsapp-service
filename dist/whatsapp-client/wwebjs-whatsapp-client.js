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
const sdk_1 = require("@in.pulse-crm/sdk");
const wwebjs_message_parser_1 = __importDefault(require("../parsers/wwebjs-message.parser"));
const prisma_service_1 = __importDefault(require("../services/prisma.service"));
const socket_service_1 = __importDefault(require("../services/socket.service"));
const processing_logger_1 = __importDefault(require("../utils/processing-logger"));
const messages_service_1 = __importDefault(require("../services/messages.service"));
const messages_distribution_service_1 = __importDefault(require("../services/messages-distribution.service"));
const internal_chats_service_1 = __importDefault(require("../services/internal-chats.service"));
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
                ...PUPPETEER_ARGS
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
    async handleQr(qr) {
        try {
            utils_1.Logger.info(`[${this.instance}:${this.id}] QR Generated!`);
            const client = await prisma_service_1.default.wppClient.findUnique({
                where: {
                    id: this.id
                },
                include: {
                    WppSector: true
                }
            });
            if (client) {
                prisma_service_1.default.wppClient.update({
                    data: {
                        phone: null
                    },
                    where: {
                        id: this.id
                    }
                });
                client.WppSector.forEach((sector) => {
                    const room = `${this.instance}:${sector.id}:admin`;
                    socket_service_1.default.emit(sdk_1.SocketEventType.WwebjsQr, room, {
                        qr,
                        phone: this.name
                    });
                });
            }
        }
        catch (err) {
            utils_1.Logger.error("Error handling QR code: " + (0, utils_1.sanitizeErrorMessage)(err));
        }
    }
    async handleAuth() {
        utils_1.Logger.info(`[${this.instance}:${this.id}] Authenticated!`);
        const client = await prisma_service_1.default.wppClient.findUnique({
            where: {
                id: this.id
            },
            include: {
                WppSector: true
            }
        });
        if (client) {
            client.WppSector.forEach((sector) => {
                const room = `${this.instance}:${sector.id}:admin`;
                socket_service_1.default.emit(sdk_1.SocketEventType.WwebjsAuth, room, {
                    phone: this.name,
                    success: true
                });
            });
        }
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
            const chat = await msg.getChat();
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
            const parsedMsg = await wwebjs_message_parser_1.default.parse(process, this.instance, msg, false, false, chat.isGroup);
            process.log(`Message is successfully parsed!`, parsedMsg);
            if (!chat.isGroup) {
                const savedMsg = await messages_service_1.default.insertMessage(parsedMsg);
                process.log(`Message is successfully saved!`);
                messages_distribution_service_1.default.processMessage(this.instance, this.id, savedMsg);
                process.log(`Message sent to distribution service!`);
                process.success(savedMsg);
            }
            if (chat.isGroup) {
                internal_chats_service_1.default.receiveMessage(chat.id.user, parsedMsg, msg.author || msg.from.split("@")[0]);
            }
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
    async sendMessage(options, isGroup = false) {
        const id = (0, node_crypto_1.randomUUID)();
        const process = new processing_logger_1.default(this.instance, "wwebjs-send-message", id, options);
        process.log("Iniciando envio de mensagem.", options);
        const to = `${options.to}${isGroup ? "@g.us" : "@c.us"}`;
        const params = {};
        if (options.quotedId) {
            params.quotedMessageId = options.quotedId;
        }
        let mentionsText = "";
        if (options.mentions?.length) {
            const mentionIds = options.mentions
                .map((user) => {
                const phone = user.phone?.replace(/\D/g, "");
                if (!phone) {
                    process.log("Telefone inválido em menção:", user);
                    return null;
                }
                return `${phone}@c.us`;
            })
                .filter((id) => id !== null);
            mentionsText = options.mentions
                .map((user) => `@${user.name || user.phone}`)
                .join(" ");
            params.mentions = mentionIds;
        }
        let content;
        if ("fileUrl" in options) {
            process.log("Preparando mídia via fileUrl:", options.fileUrl);
            if (options.sendAsAudio) {
                params.sendAudioAsVoice = true;
            }
            if (options.sendAsDocument) {
                params.sendMediaAsDocument = true;
            }
            if (!options.sendAsAudio) {
                const texto = options.text?.trim() ?? "";
                params.caption = options.mentions?.length
                    ? texto.replace(/@\s*$/, mentionsText)
                    : texto;
            }
            try {
                content = await whatsapp_web_js_1.default.MessageMedia.fromUrl(options.fileUrl, {
                    unsafeMime: true,
                    filename: options.fileName
                });
            }
            catch (err) {
                process.log("Erro ao carregar mídia:", err);
                throw err;
            }
        }
        else {
            const texto = options.text?.trim() ?? "";
            content = options.mentions?.length
                ? texto.replace(/@\s*$/, mentionsText)
                : texto;
        }
        process.log("Conteúdo final:", { content, params });
        try {
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
    async getGroups() {
        const chats = await this.wwebjs.getChats();
        return chats.filter((c) => c.isGroup);
    }
    async forwardMessage(to, messageId, isGroup = false) {
        const process = new processing_logger_1.default(this.instance, "wwebjs-forward-message", messageId, { to, messageId, isGroup });
        try {
            process.log("Buscando mensagem original...");
            const message = await this.wwebjs.getMessageById(messageId);
            if (!message) {
                process.failed("Mensagem original não encontrada.");
                throw new Error("Mensagem original não encontrada.");
            }
            const chatId = `${to}${isGroup ? "@g.us" : "@c.us"}`;
            process.log(`Encaminhando mensagem para ${chatId}`);
            await message.forward(chatId);
            process.success("Mensagem encaminhada com sucesso.");
        }
        catch (err) {
            process.failed("Erro ao encaminhar mensagem.");
            throw err;
        }
    }
}
exports.default = WWEBJSWhatsappClient;
