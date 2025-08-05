"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const whatsapp_service_1 = __importDefault(require("../services/whatsapp.service"));
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const http_errors_1 = require("@rgranatodutra/http-errors");
const gupshup_message_parser_1 = __importDefault(require("../parsers/gupshup-message.parser"));
const messages_service_1 = __importDefault(require("../services/messages.service"));
const messages_distribution_service_1 = __importDefault(require("../services/messages-distribution.service"));
const prisma_service_1 = __importDefault(require("../services/prisma.service"));
async function validateWebhookEntry(instance, data) {
    if (!data?.entry[0]?.changes[0]?.value) {
        throw new http_errors_1.BadRequestError("invalid webhook entry.");
    }
    console.dir(data, { depth: null });
    const recipient = data.entry[0].changes[0].value.metadata.display_phone_number;
    if (data.entry[0].changes[0].value?.statuses?.[0]) {
        const statusChange = data.entry[0].changes[0].value.statuses[0];
        console.log("statusChange", statusChange);
        return {
            type: "status",
            data: statusChange,
            recipient
        };
    }
    if (data.entry[0].changes[0].value?.messages?.[0]) {
        const message = await gupshup_message_parser_1.default.parse(recipient, instance, data.entry[0].changes[0].value.messages[0]);
        return { type: "message", data: message, recipient };
    }
    return null;
}
class WhatsappController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/whatsapp/groups", is_authenticated_middleware_1.default, this.getGroups);
        this.router.get("/api/whatsapp/templates", is_authenticated_middleware_1.default, this.getTemplates);
        this.router.post("/api/whatsapp/meta/:instance/webhooks", this.receiveMessage);
        this.router.get("/api/whatsapp/meta/:instance/webhooks", this.webhook);
    }
    async getGroups(req, res) {
        const groups = await whatsapp_service_1.default.getGroups(req.session.instance, req.session.sectorId);
        res.status(200).json({
            message: "Groups retrieved successfully!",
            data: groups
        });
    }
    async getTemplates(req, res) {
        const templates = await whatsapp_service_1.default.getTemplates(req.session);
        res.status(200).json({ templates });
    }
    async receiveMessage(req, res) {
        try {
            const instance = req.params["instance"];
            const entry = await validateWebhookEntry(instance, req.body);
            if (!entry) {
                res.status(200).send();
                return;
            }
            const { type, data, recipient } = entry;
            const client = await prisma_service_1.default.wppClient.findFirstOrThrow({
                where: {
                    phone: recipient
                }
            });
            switch (type) {
                case "message":
                    const savedMsg = await messages_service_1.default.insertMessage(data);
                    await messages_distribution_service_1.default.processMessage(instance, client.id, savedMsg);
                    break;
                case "status":
                    const status = gupshup_message_parser_1.default.parseStatus(data);
                    console.log("status parsed", status);
                    await messages_distribution_service_1.default.processMessageStatus("waba", data.id, status);
                    break;
                default:
                    break;
            }
            res.status(200).send();
        }
        catch (err) {
            console.error(err);
            res.status(500).send();
        }
    }
    async webhook(req, res) {
        console.log("challenge body", req.body);
        console.log("challenge headers", req.headers);
        res.status(200).send();
    }
}
exports.default = new WhatsappController((0, express_1.Router)());
