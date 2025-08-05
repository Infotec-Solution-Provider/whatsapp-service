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
function validateWebhookEntry(instance, data) {
    console.log(new Date().toLocaleString() + " GS Message: ");
    console.dir(data, { depth: null });
    if (!data?.entry[0]?.changes[0]?.value) {
        throw new http_errors_1.BadRequestError("invalid webhook entry.");
    }
    if (data.entry[0].changes[0].value?.statuses?.[0]) {
        const statusChange = data.entry[0].changes[0].value.statuses[0];
        return statusChange;
    }
    if (data.entry[0].changes[0].value?.messages?.[0]) {
        console.log(new Date().toLocaleString() + " WABA Message: ");
        console.dir(data.entry[0].changes[0].value.messages[0], {
            depth: null
        });
        const message = gupshup_message_parser_1.default.parse("", instance, data.entry[0].changes[0].value.messages[0]);
        return message;
    }
    throw new Error("unexpected webhook message format.");
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
        const instance = req.params["instance"];
        const data = validateWebhookEntry(instance, req.body);
        console.log("parsedMsg", data);
        res.status(200).send();
        res.status(500).send();
    }
    async webhook(req, res) {
        console.log("challenge body", req.body);
        console.log("challenge headers", req.headers);
        res.status(200).send();
        res.status(500).send();
    }
}
exports.default = new WhatsappController((0, express_1.Router)());
