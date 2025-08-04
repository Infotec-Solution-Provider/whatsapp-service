"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const whatsapp_service_1 = __importDefault(require("../services/whatsapp.service"));
class ResultsController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/whatsapp/results", is_authenticated_middleware_1.default, this.getResults);
    }
    async getResults(req, res) {
        const data = await whatsapp_service_1.default.getResults(req.session.instance);
        res.status(200).send({
            message: "Results retrieved successfully!",
            data
        });
    }
}
exports.default = new ResultsController((0, express_1.Router)());
