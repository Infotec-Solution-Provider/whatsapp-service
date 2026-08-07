import { Router } from "express";
import messageQueueService from "../services/message-queue.service";
import isAuthenticated from "../middlewares/is-authenticated.middleware";

const router = Router();

/**
 * GET /message-queue/stats
 * Retorna estatísticas da fila de processamento
 */
router.get("/api/whatsapp/message-queue/stats", isAuthenticated, async (_req, res) => {
	const stats = await messageQueueService.getQueueStats();
	res.json(stats);
});

/**
 * POST /message-queue/clean
 * Remove itens concluídos antigos da fila
 */
router.post("/api/whatsapp/message-queue/clean", isAuthenticated, async (_req, res) => {
	const count = await messageQueueService.cleanOldCompletedItems();
	res.json({ message: `${count} itens removidos da fila`, count });
});

/**
 * POST /message-queue/recover
 * Recupera itens travados em PROCESSING para PENDING
 */
router.post("/api/whatsapp/message-queue/recover", isAuthenticated, async (_req, res) => {
	const count = await messageQueueService.recoverStuckProcessingItems();
	res.json({ message: `${count} itens recuperados para PENDING`, count });
});

export default { router };
