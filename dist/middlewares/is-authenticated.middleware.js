"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const auth_service_1 = __importDefault(require("../services/auth.service"));
const utils_1 = require("@in.pulse-crm/utils");
async function isAuthenticated(req, res, next) {
    const authToken = req.headers["authorization"];
    if (!authToken) {
        res.status(401).json({
            message: "Unauthorized!"
        });
        return;
    }
    try {
        const session = await auth_service_1.default.fetchSessionData(authToken);
        req.session = session;
        next();
    }
    catch (err) {
        res.status(401).json({
            message: "Unauthorized!",
            cause: (0, utils_1.sanitizeErrorMessage)(err)
        });
    }
}
exports.default = isAuthenticated;
