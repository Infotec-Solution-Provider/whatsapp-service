"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const prisma_service_1 = __importDefault(require("../services/prisma.service"));
class NotificationsController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/whatsapp/notifications", is_authenticated_middleware_1.default, this.getNotifications);
        this.router.patch("/api/whatsapp/notifications/mark-all-read", is_authenticated_middleware_1.default, this.markAllAsRead);
    }
    async getNotifications(req, res) {
        const { instance } = req.session;
        const userId = req.session.userId;
        if (!userId) {
            res.status(401).send({ message: "Usuário não autenticado" });
            return;
        }
        try {
            const notifications = await prisma_service_1.default.notification.findMany({
                where: {
                    instance,
                    userId
                },
                orderBy: {
                    createdAt: "desc"
                },
                take: 50
            });
            res.status(200).send({
                message: "Notificações carregadas com sucesso!",
                data: notifications
            });
        }
        catch (error) {
            console.error("Erro ao buscar notificações:", error);
            res.status(500).send({
                message: "Erro ao buscar notificações"
            });
        }
    }
    async markAllAsRead(req, res) {
        const userId = req.session.userId;
        if (!userId) {
            res.status(401).send({ message: "Usuário não autenticado" });
            return;
        }
        try {
            await prisma_service_1.default.notification.updateMany({
                where: {
                    userId,
                    read: false
                },
                data: {
                    read: true
                }
            });
            res.status(200).send({
                message: "Todas as notificações marcadas como lidas."
            });
        }
        catch (error) {
            console.error("Erro ao marcar notificações como lidas:", error);
            res.status(500).send({
                message: "Erro ao atualizar notificações."
            });
        }
    }
}
exports.default = new NotificationsController((0, express_1.Router)());
