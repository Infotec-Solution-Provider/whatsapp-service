import { Logger } from "@in.pulse-crm/utils";
import prismaService from "../services/prisma.service";
import { MessageQueueStatus } from "@prisma/client";

/**
 * Rotina de limpeza automática da fila de mensagens
 * Remove mensagens antigas já processadas para evitar crescimento excessivo do banco
 */
export async function cleanMessageQueueRoutine(instance: string, daysOld: number = 7): Promise<void> {
	Logger.info(`[CleanMessageQueue] Iniciando limpeza de mensagens antigas (>${daysOld} dias)...`);

	try {
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - daysOld);

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

		Logger.info(`[CleanMessageQueue] Removidas ${result.count} mensagens antigas`);

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

			Logger.info(`[CleanMessageQueue] ${stuckMessages.length} mensagens resetadas para PENDING`);
		}

		// Estatísticas
		const stats = await prismaService.messageQueueItem.groupBy({
			by: ["status"],
			where: {
				instance
			},
			_count: true
		});

		Logger.info(`[CleanMessageQueue] Estatísticas atuais da fila:`);
		stats.forEach((stat) => {
			Logger.info(`  - ${stat.status}: ${stat._count}`);
		});
	} catch (err) {
		Logger.error(`[CleanMessageQueue] Erro durante limpeza: ${err}`);
	}
}

/**
 * Agenda execução periódica da rotina de limpeza
 * @param instance - Instância do WhatsApp
 * @param intervalHours - Intervalo em horas (padrão: 6 horas)
 * @param daysOld - Dias para considerar mensagem antiga (padrão: 7 dias)
 */
export function scheduleMessageQueueCleanup(
	instance: string,
	intervalHours: number = 6,
	daysOld: number = 7
): NodeJS.Timeout {
	Logger.info(
		`[CleanMessageQueue] Agendando limpeza automática a cada ${intervalHours}h (remove mensagens >${daysOld} dias)`
	);

	// Executa imediatamente
	cleanMessageQueueRoutine(instance, daysOld);

	// Agenda execução periódica
	return setInterval(
		() => {
			cleanMessageQueueRoutine(instance, daysOld);
		},
		intervalHours * 60 * 60 * 1000
	);
}

export default cleanMessageQueueRoutine;
