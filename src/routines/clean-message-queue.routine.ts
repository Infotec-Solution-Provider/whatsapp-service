import { Logger } from "@in.pulse-crm/utils";
import prismaService from "../services/prisma.service";
import { MessageQueueStatus } from "@prisma/client";
import ProcessingLogger from "../utils/processing-logger";

/**
 * Rotina de limpeza automática da fila de mensagens
 * Remove mensagens antigas já processadas para evitar crescimento excessivo do banco
 * LIMPEZA AGRESSIVA: remove mensagens processadas após apenas 1 hora
 */
export async function cleanMessageQueueRoutine(instance: string, hoursOld: number = 1): Promise<void> {
	const logger = new ProcessingLogger("system", "clean-message-queue", String(Date.now()), {});
	logger.log(`[CleanMessageQueue] Iniciando limpeza de mensagens antigas (>${hoursOld}h)...`);

	try {
		const cutoffDate = new Date();
		cutoffDate.setHours(cutoffDate.getHours() - hoursOld);

		// Remove mensagens completadas/falhas/canceladas antigas
		const result = await prismaService.messageQueueItem.deleteMany({
			where: {
				instance,
				status: {
					in: [MessageQueueStatus.COMPLETED, MessageQueueStatus.FAILED, MessageQueueStatus.CANCELLED]
				},
				processedAt: {
					lt: cutoffDate
				}
			}
		});

		if (result.count > 0) {
			logger.log(`[CleanMessageQueue] Removidas ${result.count} mensagens processadas há mais de ${hoursOld}h`);
		}

		// Verifica mensagens travadas em PROCESSING há muito tempo (possível queda não detectada)
		const stuckCutoff = new Date();
		stuckCutoff.setHours(stuckCutoff.getHours() - 1); // Mais de 1 hora em PROCESSING

		const stuckMessages = await prismaService.messageQueueItem.findMany({
			where: {
				instance,
				status: MessageQueueStatus.PROCESSING,
				processingStartedAt: {
					lt: stuckCutoff
				}
			}
		});

		if (stuckMessages.length > 0) {
			Logger.error(
				`[CleanMessageQueue] Encontradas ${stuckMessages.length} mensagens travadas em PROCESSING. Resetando...`
			);

			await prismaService.messageQueueItem.updateMany({
				where: {
					id: {
						in: stuckMessages.map((m) => m.id)
					}
				},
				data: {
					status: MessageQueueStatus.PENDING,
					processingStartedAt: null,
					error: "Reset: stuck in PROCESSING for too long"
				}
			});

			logger.log(`[CleanMessageQueue] ${stuckMessages.length} mensagens resetadas para PENDING`);
		}

		// Estatísticas
		const stats = await prismaService.messageQueueItem.groupBy({
			by: ["status"],
			where: {
				instance
			},
			_count: true
		});

		logger.log(`[CleanMessageQueue] Estatísticas atuais da fila:`);
		stats.forEach((stat) => {
			logger.log(`  - ${stat.status}: ${stat._count}`);
		});
	} catch (err) {
		Logger.error(`[CleanMessageQueue] Erro durante limpeza: ${err}`);
	}
}

/**
 * Agenda execução periódica da rotina de limpeza
 * @param instance - Instância do WhatsApp
 * @param intervalMinutes - Intervalo em minutos (padrão: 30 minutos)
 * @param hoursOld - Horas para considerar mensagem antiga (padrão: 1 hora)
 */
export function scheduleMessageQueueCleanup(
	instance: string,
	intervalMinutes: number = 30,
	hoursOld: number = 1
): NodeJS.Timeout {
	// Executa imediatamente
	cleanMessageQueueRoutine(instance, hoursOld);

	// Agenda execução periódica
	return setInterval(
		() => {
			cleanMessageQueueRoutine(instance, hoursOld);
		},
		intervalMinutes * 60 * 1000
	);
}

export default cleanMessageQueueRoutine;
