"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const schedules_service_1 = __importDefault(require("../services/schedules.service"));
const chats_service_1 = __importDefault(require("../services/chats.service"));
const internal_chats_service_1 = __importDefault(require("../services/internal-chats.service"));
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
class MonitorController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/whatsapp/monitor", is_authenticated_middleware_1.default, this.getMonitorData);
    }
    async getMonitorData(req, res) {
        const schedules = await schedules_service_1.default.getSchedulesBySession(req.session, {});
        const { chats: whatsappChats } = await chats_service_1.default.getChatsMonitor(req.session, false, true, true);
        const { chats: internalChats } = await internal_chats_service_1.default.getInternalChatsMonitor(req.session);
        const responseData = {
            schedules,
            whatsappChats,
            internalChats
        };
        res.status(200).send({
            message: "Monitor data retrieved successfully!",
            data: responseData
        });
    }
}
exports.default = new MonitorController((0, express_1.Router)());
