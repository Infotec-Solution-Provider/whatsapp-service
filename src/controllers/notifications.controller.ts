import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import prismaService from "../services/prisma.service";
class NotificationsController {
	constructor(public readonly router: Router) {
		this.router.get("/api/whatsapp/notifications", isAuthenticated, this.getNotifications);
		this.router.patch("/api/whatsapp/notifications/mark-all-read", isAuthenticated, this.markAllAsRead);
		this.router.patch("/api/whatsapp/notifications/:id/read", isAuthenticated, this.markOneAsRead);
	}

	private async getNotifications(req: Request, res: Response): Promise<void> {
		const { instance } = req.session;
		const userId = req.session.userId;

		if (!userId) {
			res.status(401).send({ message: "Usuário não autenticado" });
			return;
		}

		try {
			const page = parseInt(req.query["page"] as string) || 1;
			const pageSize = parseInt(req.query["pageSize"] as string) || 15;
			const skip = (page - 1) * pageSize;

			const [notifications, totalCount] = await prismaService.$transaction([
				prismaService.notification.findMany({
					where: {
						instance,
						userId
					},
					orderBy: {
						createdAt: "desc"
					},
					take: pageSize,
					skip: skip
				}),
				prismaService.notification.count({
					where: {
						instance,
						userId
					}
				})
			]);

			res.status(200).send({
				message: "Notificações carregadas com sucesso!",
				data: {
					notifications,
					totalCount,
					pageSize,
					currentPage: page
				}
			});
		} catch (error) {
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
			res.status(500).send({
				message: "Erro ao atualizar notificações."
			});
		}
	}
	private async markOneAsRead(req: Request, res: Response): Promise<void> {
		const userId = req.session.userId;
		const { id } = req.params;
		if (!userId) {
			res.status(401).send({ message: "Usuário não autenticado" });
			return;
		}

		try {
			await prismaService.notification.update({
				where: {
					id: Number(id),
					userId
				},
				data: {
					read: true
				}
			});

			res.status(200).send({ message: "Notificação marcada como lida." });
		} catch (error) {
			res.status(500).send({ message: "Erro ao atualizar notificação." });
		}
	}
}

export default new NotificationsController(Router());
