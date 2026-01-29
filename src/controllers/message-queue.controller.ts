import { Router } from "express";
import messageQueueService from "../services/message-queue.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";

const router = Router();

/**
 * GET /message-queue/stats
 * Retorna estatísticas da fila de processamento
 */
router.get("/message-queue/stats", isAuthenticated, async (_req, res) => {
	const stats = await messageQueueService.getQueueStats();
	res.json(stats);
});

/**
 * POST /message-queue/clean
 * Remove itens concluídos antigos da fila
 */
router.post("/message-queue/clean", isAuthenticated, async (_req, res) => {
	const count = await messageQueueService.cleanOldCompletedItems();
	res.json({ message: `${count} itens removidos da fila`, count });
});

export default { router };
