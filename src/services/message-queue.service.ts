import prismaService from "./prisma.service";
import ProcessingLogger from "../utils/processing-logger";
import { Logger } from "@in.pulse-crm/utils";

interface QueueMessageData {
  instance: string;
  clientId: number;
  messageId: number;
  contactPhone: string;
  contactName?: string | null | undefined;
  retryForever?: boolean;
}

// Interface para o handler de processamento (injetado externamente)
export interface MessageQueueProcessHandler {
  processMessage(instance: string, clientId: number, messageId: number, contactName?: string | null): Promise<any>;
}

type QueueItem = Awaited<ReturnType<typeof prismaService.wppMessageProcessingQueue.findMany>>[number];

class MessageQueueService {
  private isProcessing = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private readonly PROCESSING_INTERVAL_MS = 250; // Processa com menos pressão no banco
  private readonly LOCK_DURATION_MS = 30000; // Lock expira em 30 segundos
  private readonly MAX_CONCURRENT_CONTACTS = 5; // Reduz concorrência para aliviar o pool do Prisma
  private readonly workerId = `worker-${process.pid}-${Date.now()}`;
  private processHandler: MessageQueueProcessHandler | null = null;
  private stopping = false;

  /**
   * Define o handler que processará as mensagens
   */
  public setProcessHandler(handler: MessageQueueProcessHandler) {
    this.processHandler = handler;
  }

  /**
   * Adiciona uma mensagem na fila de processamento
   */
  public async enqueue(data: QueueMessageData): Promise<string> {
    try {
      const queueItem = await prismaService.wppMessageProcessingQueue.upsert({
        where: { messageId: data.messageId },
        create: {
          instance: data.instance,
          clientId: data.clientId,
          messageId: data.messageId,
          contactPhone: data.contactPhone,
          contactName: data.contactName ?? null,
          status: "PENDING",
          maxRetries: data.retryForever ? 0 : 3
        },
        // A redelivery only repairs a missing queue row. It must not restart a
        // message that is already PROCESSING, COMPLETED or FAILED.
        update: {}
      });

      if (data.retryForever) {
        await prismaService.wppMessageProcessingQueue.updateMany({
          where: { id: queueItem.id },
          data: { maxRetries: 0 }
        });
        await prismaService.wppMessageProcessingQueue.updateMany({
          where: { id: queueItem.id, status: "FAILED" },
          data: {
            status: "PENDING",
            error: null,
            processedAt: null,
            lockedUntil: null,
            lockedBy: null,
            processingStartedAt: null
          }
        });
      }

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
      Logger.info(`[MessageQueueService] Worker já está rodando`);
      return;
    }

    this.stopping = false;

    Logger.info(`[MessageQueueService] 🚀 Iniciando worker de processamento da fila (intervalo: ${this.PROCESSING_INTERVAL_MS}ms)`);

    this.recoverOrphanProcessingItems().catch((err) => {
      Logger.info(`[MessageQueueService] Error recovering orphan processing items: ${err.message}`);
    });

    this.processingInterval = setInterval(() => {
      this.processQueue().catch((err) => {
        // Erros ignorados intencionalmente para não bloquear o worker loop
        // Cada erro é logado individualmente no processQueueItem
        Logger.info(`[MessageQueueService] Error in processing loop: ${err.message}`);
      });
    }, this.PROCESSING_INTERVAL_MS);
    this.processingInterval.unref();

    // Processa imediatamente ao iniciar
    this.processQueue().catch((err) => {
      // Erros ignorados intencionalmente para não bloquear o worker
      Logger.info(`[MessageQueueService] Error in initial processing: ${err.message}`);
    });
  }

  /**
   * Para o worker de processamento
   */
  public stopWorker() {
    this.stopping = true;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }

  public async stopAndDrain(timeoutMs = 30_000): Promise<void> {
    this.stopWorker();
    const deadline = Date.now() + timeoutMs;
    while (this.isProcessing && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Processa itens pendentes da fila
   */
  private async processQueue() {
    if (this.stopping || this.isProcessing) {
      return;
    }
    this.isProcessing = true;

    try {
      // Libera locks expirados
      await this.releaseExpiredLocks();

      // Busca próximos itens para processar, respeitando o limite de contatos simultâneos
      const pendingItems = await prismaService.wppMessageProcessingQueue.findMany({
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
        take: this.MAX_CONCURRENT_CONTACTS * 3 // Pega mais para filtrar por contato
      }) as QueueItem[];

      if (pendingItems.length === 0) {
        return;
      }

      // Agrupa por contato e pega apenas o primeiro de cada
      const contactMap = new Map<string, typeof pendingItems[0]>();
      for (const item of pendingItems) {
        if (!contactMap.has(item.contactPhone)) {
          contactMap.set(item.contactPhone, item);
        }
      }

      // Limita ao número máximo de contatos simultâneos
      const itemsToProcess = Array.from(contactMap.values()).slice(0, this.MAX_CONCURRENT_CONTACTS);

      const claimedIds = await this.claimQueueItems(itemsToProcess.map((item) => item.id));

      if (claimedIds.length === 0) {
        return;
      }

      const claimedItems = await prismaService.wppMessageProcessingQueue.findMany({
        where: {
          id: { in: claimedIds },
          status: "PROCESSING",
          lockedBy: this.workerId
        }
      }) as QueueItem[];

      // Processa cada item em paralelo (mas apenas um por contato)
      await Promise.allSettled(claimedItems.map((item) => this.processQueueItem(item)));
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Claima em lote os itens que já vamos processar neste ciclo.
   */
  private async claimQueueItems(queueIds: string[]): Promise<string[]> {
    if (queueIds.length === 0) {
      return [];
    }

    const lockUntil = new Date(Date.now() + this.LOCK_DURATION_MS);

    await prismaService.wppMessageProcessingQueue.updateMany({
      where: {
        id: {
          in: queueIds
        },
        status: "PENDING",
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }]
      },
      data: {
        status: "PROCESSING",
        lockedUntil: lockUntil,
        lockedBy: this.workerId,
        processingStartedAt: new Date()
      }
    });

    const claimedItems = await prismaService.wppMessageProcessingQueue.findMany({
      where: {
        id: {
          in: queueIds
        },
        status: "PROCESSING",
        lockedBy: this.workerId
      },
      select: {
        id: true
      }
    });

    return claimedItems.map((item) => item.id);
  }

  /**
   * Libera locks que expiraram
   */
  private async releaseExpiredLocks() {
    try {
      const result = await prismaService.wppMessageProcessingQueue.updateMany({
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
      }
    } catch (error) {
    }
  }

  /**
   * Recupera itens PROCESSING órfãos (sem lock válido) para evitar mensagens travadas.
   */
  private async recoverOrphanProcessingItems(): Promise<number> {
    const result = await prismaService.wppMessageProcessingQueue.updateMany({
      where: {
        status: "PROCESSING",
        OR: [
          { lockedUntil: null },
          { lockedUntil: { lt: new Date() } }
        ]
      },
      data: {
        status: "PENDING",
        lockedUntil: null,
        lockedBy: null,
        processingStartedAt: null
      }
    });

    if (result.count > 0) {
      Logger.info(`[MessageQueueService] Recovered ${result.count} orphan processing items`);
    }

    return result.count;
  }

  /**
   * Processa um item individual da fila
   */
  private async processQueueItem(queueItem: QueueItem) {
    const queueId = queueItem.id;
    const logger = new ProcessingLogger("", "message-queue-worker", queueId, { queueId, workerId: this.workerId });
    let leaseHeartbeat: NodeJS.Timeout | null = null;

    try {
      const freshQueueItem = await prismaService.wppMessageProcessingQueue.findUnique({
        where: { id: queueId }
      });

      if (!freshQueueItem || freshQueueItem.status !== "PROCESSING" || freshQueueItem.lockedBy !== this.workerId) {
        logger.log("Item não está lockado por este worker. Ignorando processamento", {
          status: freshQueueItem?.status,
          lockedBy: freshQueueItem?.lockedBy || null
        });
        return;
      }

      logger.log("Lock adquirido. Iniciando processamento");

      leaseHeartbeat = setInterval(() => {
        void prismaService.wppMessageProcessingQueue.updateMany({
          where: { id: queueId, status: "PROCESSING", lockedBy: this.workerId },
          data: { lockedUntil: new Date(Date.now() + this.LOCK_DURATION_MS) }
        }).catch((error) => {
          Logger.error(`[MessageQueueService] Failed to renew lease for ${queueId}`, error as Error);
        });
      }, Math.max(1_000, Math.floor(this.LOCK_DURATION_MS / 3)));
      leaseHeartbeat.unref();

      const message = await prismaService.wppMessage.findUnique({
        where: { id: queueItem.messageId }
      });

      if (!message) {
        logger.log(`Mensagem ${queueItem.messageId} não encontrada`);
        await this.markAsFailed(queueId, "Mensagem não encontrada no banco de dados", this.workerId);
        return;
      }

      logger.log(`Processando mensagem ${message.id} do contato ${queueItem.contactPhone}`);

      // Verifica se há handler configurado
      if (!this.processHandler) {
        throw new Error("Message process handler not configured");
      }

      // Processa a mensagem usando o handler injetado
      await this.processHandler.processMessage(
        queueItem.instance,
        queueItem.clientId,
        message.id,
        queueItem.contactName
      );

      // Marca como concluído
      await this.markAsCompleted(queueId, this.workerId);
      logger.success("Mensagem processada com sucesso");
    } catch (error: any) {
      logger.log(`Erro ao processar item da fila: ${error.message}`);
      logger.failed(error);

      // Busca o item para verificar tentativas
      const queueItem = await prismaService.wppMessageProcessingQueue.findUnique({
        where: { id: queueId }
      });

      if (
        queueItem &&
        queueItem.status === "PROCESSING" &&
        queueItem.lockedBy === this.workerId &&
        (queueItem.maxRetries === 0 || queueItem.retryCount < queueItem.maxRetries)
      ) {
        const nextRetryCount = queueItem.retryCount + 1;
        const retryDelayMs = Math.min(300_000, 1_000 * 2 ** Math.min(Math.max(nextRetryCount - 1, 0), 8));
        // Incrementa contador e volta para PENDING
        await prismaService.wppMessageProcessingQueue.updateMany({
          where: { id: queueId, status: "PROCESSING", lockedBy: this.workerId },
          data: {
            status: "PENDING",
            retryCount: { increment: 1 },
            error: error.message,
            lockedUntil: new Date(Date.now() + retryDelayMs),
            lockedBy: null,
            processingStartedAt: null
          }
        });
        logger.log(`Item retornado para a fila. Tentativa ${nextRetryCount}/${queueItem.maxRetries === 0 ? "infinito" : queueItem.maxRetries}`);
      } else {
        // Excedeu tentativas, marca como falha
        if (queueItem?.status === "PROCESSING" && queueItem.lockedBy === this.workerId) {
          await this.markAsFailed(queueId, error.message, this.workerId);
        }
        logger.log("Item marcado como falha após exceder tentativas");
      }
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    }
  }

  /**
   * Marca item como concluído
   */
  private async markAsCompleted(queueId: string, ownerId: string) {
    const result = await prismaService.wppMessageProcessingQueue.updateMany({
      where: { id: queueId, status: "PROCESSING", lockedBy: ownerId },
      data: {
        status: "COMPLETED",
        processedAt: new Date(),
        lockedUntil: null,
        lockedBy: null
      }
    });
    if (result.count !== 1) throw new Error(`Message queue item ${queueId} lost its processing lease`);
  }

  /**
   * Marca item como falha
   */
  private async markAsFailed(queueId: string, error: string, ownerId: string) {
    await prismaService.wppMessageProcessingQueue.updateMany({
      where: { id: queueId, status: "PROCESSING", lockedBy: ownerId },
      data: {
        status: "FAILED",
        error: error.substring(0, 1000), // Limita tamanho do erro
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
      prismaService.wppMessageProcessingQueue.count({ where: { status: "PENDING" } }),
      prismaService.wppMessageProcessingQueue.count({ where: { status: "PROCESSING" } }),
      prismaService.wppMessageProcessingQueue.count({ where: { status: "COMPLETED" } }),
      prismaService.wppMessageProcessingQueue.count({ where: { status: "FAILED" } })
    ]);

    return { pending, processing, completed, failed, total: pending + processing + completed + failed };
  }

  /**
   * Limpa itens concluídos antigos (mais de 7 dias)
   */
  public async cleanOldCompletedItems() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const result = await prismaService.wppMessageProcessingQueue.deleteMany({
      where: {
        status: "COMPLETED",
        processedAt: {
          lt: sevenDaysAgo
        }
      }
    });

    return result.count;
  }

  /**
   * Recupera itens travados em PROCESSING para PENDING.
   */
  public async recoverStuckProcessingItems(): Promise<number> {
    return this.recoverOrphanProcessingItems();
  }
}

export default new MessageQueueService();
