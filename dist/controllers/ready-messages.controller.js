"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const http_errors_1 = require("@rgranatodutra/http-errors");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const multer_middleware_1 = __importDefault(require("../middlewares/multer.middleware"));
const ready_messages_service_1 = __importDefault(require("../services/ready-messages.service"));
class ReadyMessagesController {
    router;
    constructor(router) {
        this.router = router;
        this.router = (0, express_1.Router)();
        this.router.post("/api/ready-messages", is_authenticated_middleware_1.default, multer_middleware_1.default.single("file"), this.createReadyMessage);
        this.router.get("/api/ready-messages", is_authenticated_middleware_1.default, this.getReadyMessages);
        this.router.delete("/api/ready-messages/:id", is_authenticated_middleware_1.default, this.deleteReadyMessage);
        this.router.put("/api/ready-messages/:id", is_authenticated_middleware_1.default, multer_middleware_1.default.single("file"), this.updateReadyMessage);
    }
    async createReadyMessage(req, res) {
        const session = req.session;
        const body = JSON.parse(req.body.data);
        const { TITULO, TEXTO_MENSAGEM, SETOR: setorFromBody } = body;
        const isTI = session.sectorId === 3;
        const SETOR = isTI ? setorFromBody : session.sectorId;
        const result = await ready_messages_service_1.default.createReadyMessage(session, {
            SETOR: SETOR,
            TEXTO_MENSAGEM: TEXTO_MENSAGEM,
            TITULO: TITULO
        }, req.file || null);
        res.status(200).send({
            message: "ready message created successfully!",
            data: result
        });
    }
    async getReadyMessages(req, res) {
        const data = await ready_messages_service_1.default.getReadyMessages(req.session);
        res.status(200).send({
            message: "Ready Messages retrieved successfully!",
            data
        });
    }
    async updateReadyMessage(req, res) {
        const groupId = Number(req.params["id"]);
        const file = req.file;
        if (!file) {
            throw new http_errors_1.BadRequestError("File is required");
        }
        const updated = await ready_messages_service_1.default.updateReadyMessage(req.session, groupId, {}, file);
        res.status(200).send({
            message: "ReadyMessage updated!",
            data: updated
        });
    }
    async deleteReadyMessage(req, res) {
        const id = Number(req.params["id"]);
        await ready_messages_service_1.default.deleteReadyMessage(req.session, id);
        res.status(200).send({
            message: "Ready Message deleted successfully!"
        });
    }
}
exports.default = new ReadyMessagesController((0, express_1.Router)());
