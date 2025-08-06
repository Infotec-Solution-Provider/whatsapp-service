import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import prismaService from "../services/prisma.service"; // ajuste o caminho se necessário

class NotificationsController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/notifications",
			isAuthenticated,
			this.getNotifications
		);
		this.router.patch(
			"/api/whatsapp/notifications/mark-all-read",
			isAuthenticated,
			this.markAllAsRead
		);
	}

	private async getNotifications(req: Request, res: Response): Promise<void> {
		const { instance } = req.session;
		const userId = req.session.userId;

		if (!userId) {
			res.status(401).send({ message: "Usuário não autenticado" });
			return;
		}

		try {
			const notifications = await prismaService.notification.findMany({
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
		} catch (error) {
			console.error("Erro ao buscar notificações:", error);
			res.status(500).send({
				message: "Erro ao buscar notificações"
			});
		}
	}

	private async markAllAsRead(req: Request, res: Response): Promise<void> {
		const userId = req.session.userId;

		if (!userId) {
			res.status(401).send({ message: "Usuário não autenticado" });
			return;
		}

		try {
			await prismaService.notification.updateMany({
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
		} catch (error) {
			console.error("Erro ao marcar notificações como lidas:", error);
			res.status(500).send({
				message: "Erro ao atualizar notificações."
			});
		}
	}
}

export default new NotificationsController(Router());
