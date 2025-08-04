"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const schedules_service_1 = __importDefault(require("../services/schedules.service"));
const http_errors_1 = require("@rgranatodutra/http-errors");
class SchedulesController {
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
        const input = req.body;
        if (!input || typeof input !== "object") {
            throw new http_errors_1.BadRequestError("Invalid or missing formData!");
        }
        if (!input.contactId || typeof input.contactId !== "number") {
            throw new http_errors_1.BadRequestError("Contact ID is required and must be a number!");
        }
        if (!input.date) {
            throw new http_errors_1.BadRequestError("Schedule date is required!");
        }
        if (!input.scheduledFor || typeof input.scheduledFor !== "number") {
            throw new http_errors_1.BadRequestError("Scheduled For is required and must be a number!");
        }
        if (!input.sectorId || typeof input.sectorId !== "number") {
            throw new http_errors_1.BadRequestError("Sector ID is required and must be a number!");
        }
        const result = await schedules_service_1.default.createSchedule(req.headers.authorization.replace("Bearer ", ""), session, input);
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
exports.default = new SchedulesController((0, express_1.Router)());
