import prismaService from "./prisma.service";
import ProcessingLogger from "../utils/processing-logger";
import { Logger } from "@in.pulse-crm/utils";

interface QueueMessageData {
  instance: string;
  clientId: number;
  messageId: number;
  contactPhone: string;
  contactName?: string | null | undefined;
}

// Interface para o handler de processamento (injetado externamente)
export interface MessageQueueProcessHandler {
  processMessage(instance: string, clientId: number, messageId: number, contactName?: string | null): Promise<any>;
}

class MessageQueueService {
  private isProcessing = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private readonly PROCESSING_INTERVAL_MS = 100; // Processa a cada 100ms
  private readonly LOCK_DURATION_MS = 30000; // Lock expira em 30 segundos
  private readonly MAX_CONCURRENT_CONTACTS = 10; // Máximo de contatos diferentes processando ao mesmo tempo
  private readonly workerId = `worker-${process.pid}-${Date.now()}`;
  private processHandler: MessageQueueProcessHandler | null = null;

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
      const queueItem = await prismaService.wppMessageProcessingQueue.create({
        data: {
          instance: data.instance,
          clientId: data.clientId,
          messageId: data.messageId,
          contactPhone: data.contactPhone,
          contactName: data.contactName ?? null,
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
      return;
    }

    this.processingInterval = setInterval(() => {
      this.processQueue().catch((err) => {
        // Erros ignorados intencionalmente para não bloquear o worker loop
        // Cada erro é logado individualmente no processQueueItem
        Logger.info(`[MessageQueueService] Error in processing loop: ${err.message}`);
      });
    }, this.PROCESSING_INTERVAL_MS);

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
      Logger.debug("[MessageQueueService] Queue processing already in progress, skipping this cycle");
      return;
    }
    Logger.debug("[MessageQueueService] Starting queue processing cycle");
    
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
      });

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

      // Processa cada item em paralelo (mas apenas um por contato)
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
   * Processa um item individual da fila
   */
  private async processQueueItem(queueId: string) {
    const logger = new ProcessingLogger("", "message-queue-worker", queueId, { queueId, workerId: this.workerId });

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
      const queueItem = await prismaService.wppMessageProcessingQueue.findUnique({
        where: { id: queueId }
      });

      if (!queueItem) {
        logger.log("Item da fila não encontrado");
        return;
      }

      // Busca a mensagem
      const message = await prismaService.wppMessage.findUnique({
        where: { id: queueItem.messageId }
      });

      if (!message) {
        logger.log(`Mensagem ${queueItem.messageId} não encontrada`);
        await this.markAsFailed(queueId, "Mensagem não encontrada no banco de dados");
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
      await this.markAsCompleted(queueId);
      logger.success("Mensagem processada com sucesso");
    } catch (error: any) {
      logger.log(`Erro ao processar item da fila: ${error.message}`);
      logger.failed(error);

      // Busca o item para verificar tentativas
      const queueItem = await prismaService.wppMessageProcessingQueue.findUnique({
        where: { id: queueId }
      });

      if (queueItem && queueItem.retryCount < queueItem.maxRetries) {
        // Incrementa contador e volta para PENDING
        await prismaService.wppMessageProcessingQueue.update({
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
      const result = await prismaService.wppMessageProcessingQueue.updateMany({
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
    await prismaService.wppMessageProcessingQueue.update({
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
    await prismaService.wppMessageProcessingQueue.update({
      where: { id: queueId },
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
}

export default new MessageQueueService();
