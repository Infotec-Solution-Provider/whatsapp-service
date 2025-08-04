"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const internal_chats_service_1 = __importDefault(require("../services/internal-chats.service"));
const http_errors_1 = require("@rgranatodutra/http-errors");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const multer_middleware_1 = __importDefault(require("../middlewares/multer.middleware"));
class InternalChatsController {
    router;
    constructor(router) {
        this.router = router;
        this.router = (0, express_1.Router)();
        this.router.post("/api/internal/chats", is_authenticated_middleware_1.default, this.startInternalChat);
        this.router.get("/api/internal/session/chats", is_authenticated_middleware_1.default, this.getSessionInternalChats);
        this.router.get("/api/internal/groups", is_authenticated_middleware_1.default, this.getInternalGroups);
        this.router.post("/api/internal/chats/:id/messages", is_authenticated_middleware_1.default, multer_middleware_1.default.single("file"), this.sendMessageToChat);
        this.router.put("/api/internal/groups/:id", is_authenticated_middleware_1.default, this.updateInternalGroup);
    }
    async startInternalChat(req, res) {
        const session = req.session;
        const participants = req.body.participants;
        const isGroup = Boolean(req.body.isGroup);
        const groupName = req.body.groupName || "";
        if (!participants ||
            !Array.isArray(participants) ||
            !participants.every((v) => typeof v === "number")) {
            throw new http_errors_1.BadRequestError("Participants must be an array of numbers");
        }
        if (isGroup && groupName.length < 1) {
            throw new http_errors_1.BadRequestError("Group name is required for group chats");
        }
        const result = await internal_chats_service_1.default.createInternalChat(session, participants, isGroup, groupName);
        res.status(200).send({
            message: "Internal chat started successfully!",
            data: result
        });
    }
    async getSessionInternalChats(req, res) {
        const data = await internal_chats_service_1.default.getInternalChatsBySession(req.session);
        res.status(200).send({
            message: "Internal chats retrieved successfully!",
            data
        });
    }
    async getInternalGroups(req, res) {
        const data = await internal_chats_service_1.default.getInternalGroups(req.session);
        res.status(200).send({
            message: "Internal chats retrieved successfully!",
            data
        });
    }
    async sendMessageToChat(req, res) {
        const data = { ...req.body, file: req.file || null };
        await internal_chats_service_1.default.sendMessage(req.session, data);
        res.status(201).send({ message: "Message sent successfully!" });
    }
    async updateInternalGroup(req, res) {
        const groupId = Number(req.params["id"]);
        const updated = await internal_chats_service_1.default.updateInternalChatParticipants(groupId, req.body);
        res.status(200).send({
            message: "Group members updated!",
            data: updated
        });
    }
}
exports.default = new InternalChatsController((0, express_1.Router)());
