"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const wallets_service_1 = __importDefault(require("../services/wallets.service"));
class WalletsController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/wallets", this.getUserWallets);
    }
    async getUserWallets(req, res) {
        const userId = req.query["userId"];
        const instance = req.query["instance"];
        if (!userId || !instance) {
            res.status(400).json({
                message: "Query params 'userId' and 'instance' are required"
            });
            return;
        }
        const wallets = await wallets_service_1.default.getUserWallets(instance, Number(userId));
        res.status(200).json({
            message: "Wallets retrieved successfully!",
            data: wallets
        });
    }
}
exports.default = new WalletsController((0, express_1.Router)());
