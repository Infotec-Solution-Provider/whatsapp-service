"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMessageType = void 0;
const client_1 = require("@prisma/client");
const prisma_service_1 = __importDefault(require("./prisma.service"));
const sdk_1 = require("@in.pulse-crm/sdk");
const http_errors_1 = require("@rgranatodutra/http-errors");
const opus_audio_converter_1 = __importDefault(require("../utils/opus-audio-converter"));
const files_service_1 = __importDefault(require("./files.service"));
const messages_service_1 = __importDefault(require("./messages.service"));
const messages_distribution_service_1 = __importDefault(require("./messages-distribution.service"));
const processing_logger_1 = __importDefault(require("../utils/processing-logger"));
const utils_1 = require("@in.pulse-crm/utils");
const instances_service_1 = __importDefault(require("./instances.service"));
const wwebjs_whatsapp_client_1 = __importDefault(require("../whatsapp-client/wwebjs-whatsapp-client"));
const gupshup_whatsapp_client_1 = __importDefault(require("../whatsapp-client/gupshup-whatsapp-client"));
function getMessageType(fileType, isAudio, isDocument) {
    if (isDocument) {
        return "document";
    }
    if (isAudio) {
        return "ptt";
    }
    if (fileType.startsWith("image/")) {
        return "image";
    }
    if (fileType.startsWith("video/")) {
        return "video";
    }
    if (fileType.startsWith("audio/")) {
        return "audio";
    }
    return "document";
}
exports.getMessageType = getMessageType;
class WhatsappService {
    clients = new Map();
    async buildClients() {
        const clients = await prisma_service_1.default.wppClient.findMany();
        for (const client of clients) {
            switch (client.type) {
                case client_1.WppClientType.WWEBJS:
                    const WWEBJSClient = new wwebjs_whatsapp_client_1.default(client.id, client.instance, client.name);
                    this.clients.set(client.id, WWEBJSClient);
                    break;
                case client_1.WppClientType.WABA:
                    throw new Error("WABA client not supported yet!");
                    break;
                case client_1.WppClientType.GUPSHUP:
                    const GUPSHUPClient = new gupshup_whatsapp_client_1.default(client.id, client.instance, client.name, client.phone || "", client.gupshupToken || "", client.gupshupAppName || "", client.gupshupAppId || "");
                    this.clients.set(client.id, GUPSHUPClient);
                    break;
                default:
                    break;
            }
        }
    }
    getClient(id) {
        return this.clients.get(id);
    }
    async getClientBySector(instance, sectorId) {
        const dbClient = await prisma_service_1.default.wppClient.findFirstOrThrow({
            where: {
                instance,
                isActive: true,
                WppSector: {
                    some: {
                        id: sectorId
                    }
                }
            }
        });
        const client = this.getClient(dbClient.id);
        if (!client) {
            throw new http_errors_1.BadRequestError("Sector has no active whatsapp client!");
        }
        return client;
    }
    async sendMessage(session, to, data) {
        const { file, ...logData } = data;
        const process = new processing_logger_1.default(session.instance, "send-message", `${to}-${Date.now()}`, logData);
        process.log("Iniciando o envio da mensagem.");
        try {
            process.log("Obtendo client do whatsapp...");
            const client = await this.getClientBySector(session.instance, session.sectorId);
            process.log(`Client obtido para o setor: ${session.sectorId}`);
            const text = `*${session.name}*: ${data.text}`;
            let message = {
                instance: session.instance,
                status: "PENDING",
                timestamp: Date.now().toString(),
                from: `me:${client.phone}`,
                to: `${to}`,
                type: "chat",
                body: data.text || "",
                isForwarded: true
            };
            let options = { to, text: text };
            data.contactId && (message.contactId = +data.contactId);
            data.chatId && (message.chatId = +data.chatId);
            if (data.quotedId) {
                process.log(`Mensagem citada encontrada: ${data.quotedId}`);
                const quotedMsg = await prisma_service_1.default.wppMessage.findUniqueOrThrow({
                    where: {
                        id: +data.quotedId
                    }
                });
                options.quotedId = (quotedMsg.wwebjsId || quotedMsg.wabaId);
                message.quotedId = quotedMsg.id;
            }
            if ("fileId" in data && !!data.fileId) {
                process.log(`Processando arquivo com ID: ${data.fileId}`);
                const fileData = await files_service_1.default.fetchFileMetadata(data.fileId);
                process.log(`Arquivo encontrado: ${fileData.name}`);
                let fileType = "document";
                if (fileData.mime_type.startsWith("image/")) {
                    fileType = "image";
                }
                if (fileData.mime_type.startsWith("video/")) {
                    fileType = "video";
                }
                if (data.sendAsAudio) {
                    fileType = "audio";
                }
                options = {
                    ...options,
                    fileUrl: files_service_1.default.getFileDownloadUrl(data.fileId),
                    sendAsAudio: !!data.sendAsAudio,
                    sendAsDocument: !!data.sendAsDocument,
                    fileName: fileData.name,
                    fileType,
                    file: fileData
                };
                message.fileId = data.fileId;
                message.fileName = fileData.name;
                message.fileType = fileData.mime_type;
                message.fileSize = String(fileData.size);
                message.type = getMessageType(fileData.mime_type, !!data.sendAsAudio, !!data.sendAsDocument);
                process.log("Arquivo processado com sucesso.", message);
            }
            if ("file" in data && !!data.file) {
                process.log(`Processando arquivo enviado diretamente: ${data.file.originalname}`);
                if (data.sendAsAudio) {
                    process.log("Mensagem de audio, convertendo arquivo para mp3.");
                }
                const buffer = data.sendAsAudio
                    ? await opus_audio_converter_1.default.convert(data.file.buffer)
                    : data.file.buffer;
                if (data.sendAsAudio) {
                    process.log("Mensagem convertida com sucesso.");
                }
                const savedFile = await files_service_1.default.uploadFile({
                    instance: session.instance,
                    fileName: data.file.originalname,
                    mimeType: data.file.mimetype,
                    buffer,
                    dirType: sdk_1.FileDirType.PUBLIC
                });
                process.log(`Arquivo salvo com sucesso!`, savedFile);
                const fileUrl = files_service_1.default.getFileDownloadUrl(savedFile.id);
                let fileType = "document";
                if (data.file.mimetype.startsWith("image/")) {
                    fileType = "image";
                }
                if (data.file.mimetype.startsWith("video/")) {
                    fileType = "video";
                }
                if (data.sendAsAudio) {
                    fileType = "audio";
                }
                options = {
                    ...options,
                    fileUrl,
                    fileType,
                    sendAsAudio: data.sendAsAudio,
                    sendAsDocument: data.sendAsDocument,
                    file: savedFile
                };
                message.fileId = savedFile.id;
                message.fileName = savedFile.name;
                message.fileType = savedFile.mime_type;
                message.fileSize = String(savedFile.size);
                message.type = getMessageType(data.file.mimetype, !!data.sendAsAudio, !!data.sendAsDocument);
                process.log("Arquivo processado com sucesso.", message);
            }
            process.log("Salvando mensagem no banco de dados.", message);
            const pendingMsg = await messages_service_1.default.insertMessage(message);
            process.log("Enviando mensagem para o cliente.");
            messages_distribution_service_1.default.notifyMessage(process, pendingMsg);
            const sentMsg = await client.sendMessage(options);
            process.log("Atualizando mensagem no banco de dados.", sentMsg);
            message = {
                ...pendingMsg,
                ...sentMsg,
                status: "SENT",
                isForwarded: typeof sentMsg.isForwarded === "boolean"
                    ? sentMsg.isForwarded
                    : typeof pendingMsg.isForwarded === "boolean"
                        ? pendingMsg.isForwarded
                        : false
            };
            const savedMsg = await messages_service_1.default.updateMessage(pendingMsg.id, message);
            messages_distribution_service_1.default.notifyMessage(process, savedMsg);
            process.log("Mensagem salva no banco de dados.", savedMsg);
            process.success(savedMsg);
            return savedMsg;
        }
        catch (err) {
            console.error(err);
            process.failed("Erro ao enviar mensagem: " + (0, utils_1.sanitizeErrorMessage)(err));
            throw new http_errors_1.BadRequestError("Erro ao enviar mensagem.", err);
        }
    }
    async sendBotMessage(to, data) {
        const process = new processing_logger_1.default(data.chat.instance, "send-bot-message", `${to}-${Date.now()}`, data);
        process.log("Iniciando o envio da mensagem.");
        try {
            process.log("Obtendo client do whatsapp...");
            const client = await this.getClientBySector(data.chat.instance, data.chat.sectorId || 1);
            process.log(`Client obtido para o setor: ${data.chat.sectorId || 1}`);
            let message = {
                instance: data.chat.instance,
                status: "PENDING",
                timestamp: Date.now().toString(),
                from: `bot:${client.phone}`,
                to: `${to}`,
                type: "chat",
                body: data.text || ""
            };
            let options = { to, text: data.text };
            message.chatId = data.chat.id;
            data.chat.contactId && (message.contactId = data.chat.contactId);
            if (data.quotedId) {
                process.log(`Mensagem citada encontrada: ${data.quotedId}`);
                const quotedMsg = await prisma_service_1.default.wppMessage.findUniqueOrThrow({
                    where: {
                        id: +data.quotedId
                    }
                });
                options.quotedId = (quotedMsg.wwebjsId || quotedMsg.wabaId);
                message.quotedId = quotedMsg.id;
            }
            process.log("Salvando mensagem no banco de dados.", message);
            const pendingMsg = await messages_service_1.default.insertMessage(message);
            process.log("Enviando mensagem para o cliente.");
            const sentMsg = await client.sendMessage(options);
            process.log("Atualizando mensagem no banco de dados.", sentMsg);
            message = {
                ...pendingMsg,
                ...sentMsg,
                status: "SENT",
                isForwarded: typeof sentMsg.isForwarded === "boolean"
                    ? sentMsg.isForwarded
                    : typeof pendingMsg.isForwarded === "boolean"
                        ? pendingMsg.isForwarded
                        : false
            };
            const savedMsg = await messages_service_1.default.updateMessage(pendingMsg.id, message);
            process.log("Mensagem salva no banco de dados.", savedMsg);
            messages_distribution_service_1.default.notifyMessage(process, savedMsg);
            process.success(savedMsg);
            return savedMsg;
        }
        catch (err) {
            console.error(err);
            process.failed("Erro ao enviar mensagem: " + (0, utils_1.sanitizeErrorMessage)(err));
            throw new http_errors_1.BadRequestError("Erro ao enviar mensagem.", err);
        }
    }
    async getResults(instance) {
        const query = "SELECT CODIGO AS id, NOME AS name FROM resultados";
        const result = await instances_service_1.default.executeQuery(instance, query, []);
        return result;
    }
    unsafeGetWwebjsClient(instance) {
        const correctClient = this.getWwebjsClient(instance);
        if (correctClient) {
            return correctClient;
        }
        const clients = this.clients.values();
        const wwebjsClient = Array.from(clients).find((client) => client instanceof wwebjs_whatsapp_client_1.default && client.isReady) || null;
        return wwebjsClient;
    }
    getWwebjsClient(instance) {
        const clients = this.clients.values();
        const wwebjsClient = Array.from(clients).find((client) => client instanceof wwebjs_whatsapp_client_1.default &&
            client.instance === instance &&
            client.isReady) || null;
        return wwebjsClient;
    }
    async getValidWhatsappPhone(instance, phone) {
        const wwebjs = this.unsafeGetWwebjsClient(instance);
        const validPhone = wwebjs
            ? await wwebjs?.getValidWhatsapp(phone)
            : null;
        return validPhone;
    }
    async getProfilePictureUrl(instance, phone) {
        try {
            const wwebjs = this.unsafeGetWwebjsClient(instance);
            const url = wwebjs
                ? await wwebjs?.getProfilePictureUrl(phone)
                : null;
            return url;
        }
        catch {
            return null;
        }
    }
    async getGroups(instance, sectorId) {
        const client = await this.getClientBySector(instance, sectorId);
        if (!(client instanceof wwebjs_whatsapp_client_1.default)) {
            throw new http_errors_1.BadRequestError("Client is not WWEBJS client");
        }
        const groups = await client.getGroups();
        return groups;
    }
    getGupshupClient(session) {
        const client = this.getClientBySector(session.instance, session.sectorId);
        if (!(client instanceof gupshup_whatsapp_client_1.default)) {
            throw new Error("Invalid WhatsApp client type for Gupshup service.");
        }
        return client;
    }
    async sendTemplate(session, to, data) {
        const process = new processing_logger_1.default(session.instance, "send-template", `${to}-${Date.now()}`, data);
        try {
            const client = this.getGupshupClient(session);
            const message = await client.sendTemplate({
                to,
                templateId: data.templateId,
                templateText: data.templateText,
                parameters: data.templateParams
            });
            const savedMsg = await messages_service_1.default.insertMessage(message);
            process.log("Mensagem salva no banco de dados.", savedMsg);
            messages_distribution_service_1.default.notifyMessage(process, savedMsg);
            process.success("Mensagem de template enviada com sucesso.");
        }
        catch (error) {
            process.failed("Erro ao enviar mensagem de template.\n" +
                (0, utils_1.sanitizeErrorMessage)(error));
        }
    }
    async getTemplates(session) {
        const client = this.getGupshupClient(session);
        return await client.getTemplates();
    }
}
exports.default = new WhatsappService();
