"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const sectors_service_1 = __importDefault(require("../services/sectors.service"));
class SectorsController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/whatsapp/sectors", is_authenticated_middleware_1.default, this.getSectors);
    }
    async getSectors(req, res) {
        const instance = req.session.instance;
        const wallets = await sectors_service_1.default.getSectors(instance);
        res.status(200).json({
            message: "Sectors retrieved successfully!",
            data: wallets
        });
    }
}
exports.default = new SectorsController((0, express_1.Router)());
