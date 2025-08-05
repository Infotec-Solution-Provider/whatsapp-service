"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const chats_service_1 = __importDefault(require("../services/chats.service"));
const http_errors_1 = require("@rgranatodutra/http-errors");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
class ChatsController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/whatsapp/session/chats", is_authenticated_middleware_1.default, this.getChatsBySession);
        this.router.get("/api/whatsapp/chats/:id", is_authenticated_middleware_1.default, this.getChatById);
        this.router.post("/api/whatsapp/chats/:id/finish", is_authenticated_middleware_1.default, this.finishChatById);
        this.router.post("/api/whatsapp/chats", is_authenticated_middleware_1.default, this.startChatByContactId);
        this.router.get("/api/whatsapp/session/monitor", is_authenticated_middleware_1.default, this.getChatsMonitor);
        this.router.post("/api/whatsapp/chats/:id/transfer", is_authenticated_middleware_1.default, this.transferAttendance);
    }
    async getChatsBySession(req, res) {
        const includeMessages = Boolean(req.query["messages"] === "true");
        const includeContact = Boolean(req.query["contact"] === "true");
        const data = await chats_service_1.default.getUserChatsBySession(req.session, includeMessages, includeContact);
        res.status(200).send({
            message: "Chats retrieved successfully!",
            data
        });
    }
    async getChatsMonitor(req, res) {
        const data = await chats_service_1.default.getChatsMonitor(req.session);
        res.status(200).send({
            message: "Chats Monitor retrieved successfully!",
            data
        });
    }
    async getChatById(req, res) {
        const { id } = req.params;
        if (!id) {
            throw new http_errors_1.BadRequestError("Chat ID is required!");
        }
        const chat = await chats_service_1.default.getChatById(Number(id));
        if (!chat) {
            throw new http_errors_1.NotFoundError("Chat not found!");
        }
        res.status(200).send({
            message: "Chat retrieved successfully!",
            data: chat
        });
    }
    async transferAttendance(req, res) {
        const { id } = req.params;
        const userId = req.body.userId;
        if (!id || isNaN(Number(id))) {
            throw new http_errors_1.BadRequestError("Chat ID is required!");
        }
        if (!userId || isNaN(Number(userId))) {
            throw new http_errors_1.BadRequestError("User ID is required!");
        }
        const session = req.session;
        await chats_service_1.default.transferAttendance(req.headers["authorization"], session, Number(id), +userId);
        res.status(200).send({
            message: "Attendance transfer successfully!"
        });
    }
    async finishChatById(req, res) {
        const { id } = req.params;
        const resultId = req.body.resultId;
        if (!id || isNaN(Number(id))) {
            throw new http_errors_1.BadRequestError("Chat ID is required!");
        }
        if (!resultId || isNaN(Number(resultId))) {
            throw new http_errors_1.BadRequestError("Result ID is required!");
        }
        const session = req.session;
        await chats_service_1.default.finishChatById(req.headers["authorization"], session, Number(id), +resultId);
        res.status(200).send({
            message: "Chat finished successfully!"
        });
    }
    async startChatByContactId(req, res) {
        const contactId = +req.body.contactId;
        const template = req.body.template;
        const session = req.session;
        if (Number.isNaN(contactId)) {
            throw new http_errors_1.BadRequestError("Contact ID is required!");
        }
        console.log("template", template);
        const result = await chats_service_1.default.startChatByContactId(session, req.headers["authorization"], contactId, template);
        res.status(200).send({
            message: "Chat started successfully!",
            data: result
        });
    }
}
exports.default = new ChatsController((0, express_1.Router)());
