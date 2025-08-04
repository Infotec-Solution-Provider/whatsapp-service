"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const schedules_service_1 = __importDefault(require("../services/schedules.service"));
const http_errors_1 = require("@rgranatodutra/http-errors");
class ChatsController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/whatsapp/schedules", is_authenticated_middleware_1.default, this.getSchedulesBySession);
        this.router.post("/api/whatsapp/schedules", is_authenticated_middleware_1.default, this.createSchedule);
        this.router.patch("/api/whatsapp/schedules/:id", is_authenticated_middleware_1.default, this.editSchedule);
        this.router.delete("/api/whatsapp/schedules/:id", is_authenticated_middleware_1.default, this.deleteSchedule);
    }
    async getSchedulesBySession(req, res) {
        const { userId, sectorId } = req.query;
        let filters = {};
        if (userId && isNaN(Number(userId))) {
            throw new http_errors_1.BadRequestError("User ID must be a number!");
        }
        else {
            filters = { ...filters, userId: Number(userId) };
        }
        if (sectorId && isNaN(Number(sectorId))) {
            throw new http_errors_1.BadRequestError("Sector ID must be a number!");
        }
        else {
            filters = { ...filters, sectorId: Number(sectorId) };
        }
        const data = await schedules_service_1.default.getSchedulesBySession(req.session, filters);
        res.status(200).send({
            message: "Schedules retrieved successfully!",
            data
        });
    }
    async createSchedule(req, res) {
        const session = req.session;
        const formData = req.body;
        if (!formData || typeof formData !== "object") {
            throw new http_errors_1.BadRequestError("Invalid or missing formData!");
        }
        const scheduleData = {
            ...formData,
            scheduleDate: new Date(formData.scheduleDate),
            instance: session.instance
        };
        if (!scheduleData.name || typeof scheduleData.name !== "string") {
            throw new http_errors_1.BadRequestError("Schedule name is required and must be a string!");
        }
        if (!scheduleData.contactId ||
            typeof scheduleData.contactId !== "number") {
            throw new http_errors_1.BadRequestError("Contact ID is required and must be a number!");
        }
        if (!scheduleData.scheduleDate ||
            !(scheduleData.scheduleDate instanceof Date)) {
            throw new http_errors_1.BadRequestError("Valid schedule date is required!");
        }
        if (!scheduleData.scheduledBy ||
            typeof scheduleData.scheduledBy !== "number") {
            throw new http_errors_1.BadRequestError("Scheduled By is required and must be a number!");
        }
        if (!scheduleData.scheduledFor ||
            typeof scheduleData.scheduledFor !== "number") {
            throw new http_errors_1.BadRequestError("Scheduled For is required and must be a number!");
        }
        if (!scheduleData.sectorId ||
            typeof scheduleData.sectorId !== "number") {
            throw new http_errors_1.BadRequestError("Sector ID is required and must be a number!");
        }
        const result = await schedules_service_1.default.createSchedule(scheduleData);
        res.status(200).send({
            message: "Schedule created successfully!",
            data: result
        });
    }
    async editSchedule(req, res) {
        const formData = req.body;
        const { id } = req.params;
        if (!id) {
            throw new http_errors_1.BadRequestError("Message ID is required!");
        }
        if (!formData || typeof formData !== "object") {
            throw new http_errors_1.BadRequestError("Invalid or missing formData!");
        }
        let scheduleData = formData;
        if (scheduleData.name && typeof scheduleData.name !== "string") {
            throw new http_errors_1.BadRequestError("Schedule name must be a string!");
        }
        if (scheduleData.contactId &&
            typeof scheduleData.contactId !== "number") {
            throw new http_errors_1.BadRequestError("Contact ID must be a number!");
        }
        if (scheduleData.scheduleDate &&
            !(scheduleData.scheduleDate instanceof Date)) {
            throw new http_errors_1.BadRequestError("Invalid schedule date!");
        }
        if (scheduleData.scheduledBy &&
            typeof scheduleData.scheduledBy !== "number") {
            throw new http_errors_1.BadRequestError("Scheduled By must be a number!");
        }
        if (scheduleData.scheduledFor &&
            typeof scheduleData.scheduledFor !== "number") {
            throw new http_errors_1.BadRequestError("Scheduled For must be a number!");
        }
        if (scheduleData.sectorId &&
            typeof scheduleData.sectorId !== "number") {
            throw new http_errors_1.BadRequestError("Sector ID must be a number!");
        }
        const result = await schedules_service_1.default.editSchedule(scheduleData, +id);
        res.status(200).send({
            message: "Schedule patched successfully!",
            data: result
        });
    }
    async deleteSchedule(req, res) {
        const { id } = req.params;
        if (!id) {
            throw new http_errors_1.BadRequestError("Message ID is required!");
        }
        const result = await schedules_service_1.default.deleteSchedule(+id);
        res.status(200).send({
            message: "Schedule deleted successfully!",
            data: result
        });
    }
}
exports.default = new ChatsController((0, express_1.Router)());
