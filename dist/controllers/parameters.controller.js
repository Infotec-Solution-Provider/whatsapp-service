"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const parameters_service_1 = __importDefault(require("../services/parameters.service"));
class ParametersController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/whatsapp/session/parameters", is_authenticated_middleware_1.default, this.getParmetersBySession);
    }
    async getParmetersBySession(req, res) {
        const parameters = await parameters_service_1.default.getSessionParams(req.session);
        res.status(200).send({
            message: "successfuly loaded session parameters",
            parameters
        });
    }
}
exports.default = new ParametersController((0, express_1.Router)());
