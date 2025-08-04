"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const messages_service_1 = __importDefault(require("../services/messages.service"));
const http_errors_1 = require("@rgranatodutra/http-errors");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const whatsapp_service_1 = __importDefault(require("../services/whatsapp.service"));
const multer_middleware_1 = __importDefault(require("../middlewares/multer.middleware"));
class MessagesController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/whatsapp/messages/:id", is_authenticated_middleware_1.default, this.getMessageById);
        this.router.patch("/api/whatsapp/messages/mark-as-read", is_authenticated_middleware_1.default, this.readContactMessages);
        this.router.post("/api/whatsapp/messages", multer_middleware_1.default.single("file"), is_authenticated_middleware_1.default, this.sendMessage);
    }
    async getMessageById(req, res) {
        const { id } = req.params;
        if (!id) {
            throw new http_errors_1.BadRequestError("Message ID is required!");
        }
        const data = await messages_service_1.default.getMessageById(req.session, +id);
        if (!data) {
            throw new http_errors_1.BadRequestError("Message not found!");
        }
        res.status(200).send({
            message: "Message retrieved successfully!",
            data
        });
    }
    async readContactMessages(req, res) {
        const contactId = req.body.contactId;
        if (!contactId) {
            throw new http_errors_1.BadRequestError("Contact ID is required!");
        }
        const updatedData = await messages_service_1.default.markContactMessagesAsRead(req.session.instance, contactId);
        res.status(200).send({
            message: "Messages marked as read successfully!",
            data: updatedData
        });
    }
    async sendMessage(req, res) {
        const { to, ...data } = req.body;
        const file = req.file;
        if (file) {
            data.file = file;
        }
        Object.keys(data).forEach(key => {
            if (data[key] === undefined) {
                delete data[key];
            }
        });
        const message = await whatsapp_service_1.default.sendMessage(req.session, to, data);
        res.status(201).send({
            message: "Message sent successfully!",
            data: message
        });
    }
}
exports.default = new MessagesController((0, express_1.Router)());
