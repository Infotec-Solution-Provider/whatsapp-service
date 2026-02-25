import "dotenv/config";
import { Logger } from "@in.pulse-crm/utils";
import { GupshupWebhookQueueStatus, PrismaClient } from "@prisma/client";
import gupshupService from "./gupshup.service";

const prisma = new PrismaClient();

const QUEUE_POLL_INTERVAL = parseInt(process.env["GUPSHUP_WEBHOOK_QUEUE_POLL_INTERVAL"] || "1000", 10);
const MAX_CONCURRENT_PROCESSING = parseInt(process.env["GUPSHUP_WEBHOOK_MAX_CONCURRENT"] || "5", 10);

class GupshupWebhookQueueService {
  private isProcessing = false;
  private activeProcessing = 0;

  /**
   * Enqueue a webhook for later processing
   */
  async enqueue(instance: string, payload: unknown): Promise<string> {
    const item = await prisma.gupshupWebhookQueue.create({
      data: {
        instance,
        payload: payload as any,
        status: GupshupWebhookQueueStatus.PENDING,
        maxRetries: 3
      }
    });
    return item.id;
  }

  /**
   * Start the queue processor
   */
  startProcessor(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    Logger.info("Starting Gupshup webhook queue processor");
    this.processLoop();
  }

  /**
   * Stop the queue processor
   */
  stopProcessor(): void {
    this.isProcessing = false;
    Logger.info("Stopping Gupshup webhook queue processor");
  }

  private async processLoop(): Promise<void> {
    while (this.isProcessing) {
      try {
        if (this.activeProcessing < MAX_CONCURRENT_PROCESSING) {
          const item = await this.getNextPendingItem();
          if (item) {
            this.activeProcessing++;
            this.processItem(item.id).finally(() => {
              this.activeProcessing--;
            });
          }
        }
      } catch (err) {
        Logger.error("Error in webhook queue loop", err as Error);
      }

      await this.sleep(QUEUE_POLL_INTERVAL);
    }
  }

  private async getNextPendingItem() {
    return prisma.gupshupWebhookQueue.findFirst({
      where: {
        status: GupshupWebhookQueueStatus.PENDING
      },
      orderBy: {
        createdAt: "asc"
      }
    });
  }

  private async processItem(id: string): Promise<void> {
    const item = await prisma.gupshupWebhookQueue.update({
      where: { id },
      data: {
        status: GupshupWebhookQueueStatus.PROCESSING,
        processingStartedAt: new Date()
      }
    });

    try {
      // Handle redirect for exatron instance
      const redirectExatron = process.env["REDIRECT_EXATRON_GUPSHUP_WEBHOOK"] === "true";
      if (item.instance === "exatron" && redirectExatron && !item.redirected) {
        await this.redirectExatronWebhook(item.payload);
        await prisma.gupshupWebhookQueue.update({
          where: { id },
          data: { redirected: true }
        });
      }

      // Process the webhook
      await gupshupService.handleWebhookEntry(item.instance, item.payload);

      // Mark as completed
      await prisma.gupshupWebhookQueue.update({
        where: { id },
        data: {
          status: GupshupWebhookQueueStatus.COMPLETED,
          processedAt: new Date()
        }
      });
    } catch (err: any) {
      const newRetryCount = item.retryCount + 1;
      const shouldRetry = newRetryCount < item.maxRetries;

      await prisma.gupshupWebhookQueue.update({
        where: { id },
        data: {
          status: shouldRetry ? GupshupWebhookQueueStatus.PENDING : GupshupWebhookQueueStatus.FAILED,
          retryCount: newRetryCount,
          error: JSON.stringify({ message: err?.message, stack: err?.stack }),
          processedAt: shouldRetry ? null : new Date()
        }
      });
    }
  }

  private async redirectExatronWebhook(payload: unknown): Promise<void> {
    const exatronWebhookUrl = process.env["EXATRON_GUPSHUP_WEBHOOK_URL"];
    if (!exatronWebhookUrl) {
      throw new Error("Exatron webhook URL is not configured");
    }
    await fetch(exatronWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get queue statistics
   */
  async getStats() {
    const [pending, processing, completed, failed] = await Promise.all([
      prisma.gupshupWebhookQueue.count({ where: { status: GupshupWebhookQueueStatus.PENDING } }),
      prisma.gupshupWebhookQueue.count({ where: { status: GupshupWebhookQueueStatus.PROCESSING } }),
      prisma.gupshupWebhookQueue.count({ where: { status: GupshupWebhookQueueStatus.COMPLETED } }),
      prisma.gupshupWebhookQueue.count({ where: { status: GupshupWebhookQueueStatus.FAILED } })
    ]);

    return { pending, processing, completed, failed, activeProcessing: this.activeProcessing };
  }

  /**
   * Retry all failed items
   */
  async retryFailed(): Promise<number> {
    const result = await prisma.gupshupWebhookQueue.updateMany({
      where: { status: GupshupWebhookQueueStatus.FAILED },
      data: {
        status: GupshupWebhookQueueStatus.PENDING,
        retryCount: 0,
        error: null
      }
    });
    return result.count;
  }
}

export default new GupshupWebhookQueueService();
