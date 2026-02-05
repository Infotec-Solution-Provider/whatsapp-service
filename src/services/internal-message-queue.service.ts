import prismaService from "./prisma.service";
import ProcessingLogger from "../utils/processing-logger";
import { Logger } from "@in.pulse-crm/utils";
import CreateMessageDto from "../dtos/create-message.dto";

interface QueueInternalMessageData {
	instance: string;
	internalChatId: number;
	groupId: string;
	messageData: CreateMessageDto;
	authorName?: string | null | undefined;
}

// Interface para o handler de processamento (injetado externamente)
export interface InternalMessageQueueProcessHandler {
	processInternalMessage(instance: string, internalChatId: number, queueId: string, groupId: string, messageData: CreateMessageDto, authorName?: string | null): Promise<any>;
}

class InternalMessageQueueService {
	private isProcessing = false;
	private processingInterval: NodeJS.Timeout | null = null;
	private readonly PROCESSING_INTERVAL_MS = 100; // Processa a cada 100ms
	private readonly LOCK_DURATION_MS = 30000; // Lock expira em 30 segundos
	private readonly MAX_CONCURRENT_CHATS = 10; // Máximo de chats diferentes processando ao mesmo tempo
	private readonly workerId = `worker-${process.pid}-${Date.now()}`;
	private processHandler: InternalMessageQueueProcessHandler | null = null;

	/**
	 * Define o handler que processará as mensagens internas
	 */
	public setProcessHandler(handler: InternalMessageQueueProcessHandler) {
		this.processHandler = handler;
	}

	/**
	 * Adiciona uma mensagem interna na fila de processamento
	 */
	public async enqueue(data: QueueInternalMessageData): Promise<string> {
		try {
			const queueItem = await prismaService.internalMessageProcessingQueue.create({
				data: {
					instance: data.instance,
					internalChatId: data.internalChatId,
					groupId: data.groupId,
					messageData: JSON.stringify(data.messageData),
					authorName: data.authorName ?? null,
					status: "PENDING"
				}
			});

			return queueItem.id;
		} catch (error) {
			throw error;
		}
	}

	/**
	 * Inicia o worker de processamento da fila
	 */
	public startWorker() {
		if (this.processingInterval) {
			Logger.info(`[InternalMessageQueueService] Worker já está rodando`);
			return;
		}

		Logger.info(`[InternalMessageQueueService] 🚀 Iniciando worker de processamento da fila (intervalo: ${this.PROCESSING_INTERVAL_MS}ms)`);

		this.processingInterval = setInterval(() => {
			this.processQueue().catch((err) => {
				Logger.info(`[InternalMessageQueueService] Error in processing loop: ${err.message}`);
			});
		}, this.PROCESSING_INTERVAL_MS);

		// Processa imediatamente ao iniciar
		this.processQueue().catch((err) => {
			Logger.info(`[InternalMessageQueueService] Error in initial processing: ${err.message}`);
		});
	}

	/**
	 * Para o worker de processamento
	 */
	public stopWorker() {
		if (this.processingInterval) {
			clearInterval(this.processingInterval);
			this.processingInterval = null;
		}
	}

	/**
	 * Processa itens pendentes da fila
	 */
	private async processQueue() {
		if (this.isProcessing) {
			return;
		}
		this.isProcessing = true;

		try {
			// Libera locks expirados
			await this.releaseExpiredLocks();

			// Busca próximos itens para processar, respeitando o limite de chats simultâneos
			const pendingItems = await prismaService.internalMessageProcessingQueue.findMany({
				where: {
					status: "PENDING",
					OR: [
						{ lockedUntil: null },
						{ lockedUntil: { lt: new Date() } }
					]
				},
				orderBy: {
					createdAt: "asc"
				},
				take: this.MAX_CONCURRENT_CHATS * 3
			});

			if (pendingItems.length === 0) {
				return;
			}

			// Agrupa por chat e pega apenas o primeiro de cada
			const chatMap = new Map<number, typeof pendingItems[0]>();
			for (const item of pendingItems) {
				if (!chatMap.has(item.internalChatId)) {
					chatMap.set(item.internalChatId, item);
				}
			}

			// Limita ao número máximo de chats simultâneos
			const itemsToProcess = Array.from(chatMap.values()).slice(0, this.MAX_CONCURRENT_CHATS);

			// Processa cada item em paralelo (mas apenas um por chat)
			await Promise.allSettled(
				itemsToProcess.map((item) => this.processQueueItem(item.id))
			);
		} finally {
			this.isProcessing = false;
		}
	}

	/**
	 * Libera locks que expiraram
	 */
	private async releaseExpiredLocks() {
		try {
			const result = await prismaService.internalMessageProcessingQueue.updateMany({
				where: {
					status: "PROCESSING",
					lockedUntil: {
						lt: new Date()
					}
				},
				data: {
					status: "PENDING",
					lockedUntil: null,
					lockedBy: null,
					processingStartedAt: null
				}
			});

			if (result.count > 0) {
				Logger.info(`[InternalMessageQueueService] ${result.count} locks expirados foram liberados`);
			}
		} catch (error) {
			// Erros silenciosos
		}
	}

	/**
	 * Processa um item individual da fila
	 */
	private async processQueueItem(queueId: string) {
		const logger = new ProcessingLogger("", "internal-message-queue-worker", queueId, { queueId, workerId: this.workerId });

		try {
			logger.log("Tentando adquirir lock para processar item da fila");

			// Tenta adquirir lock
			const lockUntil = new Date(Date.now() + this.LOCK_DURATION_MS);
			const locked = await this.acquireLock(queueId, lockUntil);

			if (!locked) {
				logger.log("Não foi possível adquirir lock (já está sendo processado)");
				return;
			}

			logger.log("Lock adquirido. Iniciando processamento");

			// Busca o item completo
			const queueItem = await prismaService.internalMessageProcessingQueue.findUnique({
				where: { id: queueId }
			});

			if (!queueItem) {
				logger.log("Item da fila não encontrado");
				return;
			}

			logger.log(`Processando mensagem interna do chat ${queueItem.internalChatId}, grupo ${queueItem.groupId}`);

			// Verifica se há handler configurado
			if (!this.processHandler) {
				throw new Error("Internal message process handler not configured");
			}

			// Parse do messageData
			const messageData = JSON.parse(queueItem.messageData) as CreateMessageDto;

			// Processa a mensagem usando o handler injetado
			await this.processHandler.processInternalMessage(
				queueItem.instance,
				queueItem.internalChatId,
				queueItem.id,
				queueItem.groupId,
				messageData,
				queueItem.authorName
			);

			// Marca como concluído
			await this.markAsCompleted(queueId);
			logger.success("Mensagem interna processada com sucesso");
		} catch (error: any) {
			logger.log(`Erro ao processar item da fila: ${error.message}`);
			logger.failed(error);

			// Busca o item para verificar tentativas
			const queueItem = await prismaService.internalMessageProcessingQueue.findUnique({
				where: { id: queueId }
			});

			if (queueItem && queueItem.retryCount < queueItem.maxRetries) {
				// Incrementa contador e volta para PENDING
				await prismaService.internalMessageProcessingQueue.update({
					where: { id: queueId },
					data: {
						status: "PENDING",
						retryCount: { increment: 1 },
						error: error.message,
						lockedUntil: null,
						lockedBy: null
					}
				});
				logger.log(`Item retornado para a fila. Tentativa ${queueItem.retryCount + 1}/${queueItem.maxRetries}`);
			} else {
				// Excedeu tentativas, marca como falha
				await this.markAsFailed(queueId, error.message);
				logger.log("Item marcado como falha após exceder tentativas");
			}
		}
	}

	/**
	 * Tenta adquirir lock para processar um item
	 */
	private async acquireLock(queueId: string, lockUntil: Date): Promise<boolean> {
		try {
			const result = await prismaService.internalMessageProcessingQueue.updateMany({
				where: {
					id: queueId,
					status: "PENDING",
					OR: [
						{ lockedUntil: null },
						{ lockedUntil: { lt: new Date() } }
					]
				},
				data: {
					status: "PROCESSING",
					lockedUntil: lockUntil,
					lockedBy: this.workerId,
					processingStartedAt: new Date()
				}
			});

			return result.count > 0;
		} catch (error) {
			return false;
		}
	}

	/**
	 * Marca item como concluído
	 */
	private async markAsCompleted(queueId: string) {
		await prismaService.internalMessageProcessingQueue.update({
			where: { id: queueId },
			data: {
				status: "COMPLETED",
				processedAt: new Date(),
				lockedUntil: null,
				lockedBy: null
			}
		});
	}

	/**
	 * Marca item como falha
	 */
	private async markAsFailed(queueId: string, error: string) {
		await prismaService.internalMessageProcessingQueue.update({
			where: { id: queueId },
			data: {
				status: "FAILED",
				error: error.substring(0, 1000),
				processedAt: new Date(),
				lockedUntil: null,
				lockedBy: null
			}
		});
	}

	/**
	 * Retorna estatísticas da fila
	 */
	public async getQueueStats() {
		const [pending, processing, completed, failed] = await Promise.all([
			prismaService.internalMessageProcessingQueue.count({ where: { status: "PENDING" } }),
			prismaService.internalMessageProcessingQueue.count({ where: { status: "PROCESSING" } }),
			prismaService.internalMessageProcessingQueue.count({ where: { status: "COMPLETED" } }),
			prismaService.internalMessageProcessingQueue.count({ where: { status: "FAILED" } })
		]);

		return { pending, processing, completed, failed, total: pending + processing + completed + failed };
	}

	/**
	 * Limpa itens concluídos antigos (mais de 7 dias)
	 */
	public async cleanOldCompletedItems() {
		const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

		const result = await prismaService.internalMessageProcessingQueue.deleteMany({
			where: {
				status: "COMPLETED",
				processedAt: {
					lt: sevenDaysAgo
				}
			}
		});

		return result.count;
	}
}

export default new InternalMessageQueueService();
