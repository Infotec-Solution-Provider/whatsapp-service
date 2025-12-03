import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import prismaService from "../services/prisma.service";
import { MessageQueueStatus } from "@prisma/client";

interface QueuedMessage {
	id: string;
	chatId: string;
	dbId: string; // ID do registro no banco
	execute: () => Promise<any>;
	resolve: (value: any) => void;
	reject: (error: any) => void;
}

interface EnqueueOptions {
	priority?: number; // Maior = mais prioritário
	maxRetries?: number;
}

/**
 * Gerencia fila de mensagens para envio sequencial com persistência em banco
 * Garante que mensagens não sejam perdidas em caso de quedas do sistema
 */
export class MessageQueue {
	private queues: Map<string, QueuedMessage[]> = new Map();
	private processing: Set<string> = new Set();
	private initialized: boolean = false;

	/**
	 * Inicializa a fila recuperando mensagens pendentes do banco
	 */
	public async initialize(instance: string, clientId: number): Promise<void> {
		if (this.initialized) return;

		Logger.info(`[MessageQueue] Inicializando fila para instância ${instance}, client ${clientId}`);

		try {
			// Recupera mensagens que estavam sendo processadas (possível queda)
			await prismaService.messageQueueItem.updateMany({
				where: {
					instance,
					clientId,
					status: MessageQueueStatus.PROCESSING
				},
				data: {
					status: MessageQueueStatus.PENDING,
					processingStartedAt: null
				}
			});

			// Recupera todas as mensagens pendentes
			const pendingMessages = await prismaService.messageQueueItem.findMany({
				where: {
					instance,
					clientId,
					status: MessageQueueStatus.PENDING
				},
				orderBy: [{ priority: "desc" }, { createdAt: "asc" }]
			});

			Logger.info(
				`[MessageQueue] Recuperadas ${pendingMessages.length} mensagens pendentes da instância ${instance}`
			);

			// TODO: Reprocessar mensagens pendentes
			// Por enquanto, apenas logamos. A reprocessamento precisa ser implementado
			// com acesso ao client WhatsApp apropriado
			if (pendingMessages.length > 0) {
				Logger.error(
					`[MessageQueue] Existem ${pendingMessages.length} mensagens pendentes que precisam ser reprocessadas manualmente`
				);
			}

			this.initialized = true;
		} catch (err) {
			Logger.error(`[MessageQueue] Erro ao inicializar fila: ${sanitizeErrorMessage(err)}`);
			throw err;
		}
	}

	/**
	 * Adiciona uma mensagem à fila de um chat específico
	 * @param instance - Instância do WhatsApp
	 * @param clientId - ID do cliente WhatsApp
	 * @param chatId - ID do chat
	 * @param messageId - ID único da mensagem
	 * @param payload - Dados da mensagem
	 * @param executor - Função que executa o envio
	 * @param options - Opções adicionais (prioridade, retries)
	 */
	public async enqueue<T>(
		instance: string,
		clientId: number,
		chatId: string,
		messageId: string,
		payload: any,
		isGroup: boolean,
		executor: () => Promise<T>,
		options: EnqueueOptions = {}
	): Promise<T> {
		const { priority = 0, maxRetries = 3 } = options;

		// Persiste no banco antes de adicionar à fila em memória
		const dbItem = await prismaService.messageQueueItem.create({
			data: {
				id: messageId,
				instance,
				clientId,
				chatId,
				payload,
				isGroup,
				priority,
				maxRetries,
				status: MessageQueueStatus.PENDING
			}
		});

		Logger.debug(`[MessageQueue] Mensagem ${messageId} persistida no banco (chat: ${chatId})`);

		return new Promise((resolve, reject) => {
			const queuedMessage: QueuedMessage = {
				id: messageId,
				chatId,
				dbId: dbItem.id,
				execute: executor,
				resolve,
				reject
			};

			// Adiciona à fila do chat
			if (!this.queues.has(chatId)) {
				this.queues.set(chatId, []);
			}

			const queue = this.queues.get(chatId)!;
			
			// Insere respeitando prioridade (maior prioridade no início)
			if (priority > 0) {
				queue.unshift(queuedMessage);
			} else {
				queue.push(queuedMessage);
			}

			Logger.debug(`[MessageQueue] Mensagem ${messageId} adicionada à fila do chat ${chatId}`);

			// Inicia processamento se não estiver em andamento
			if (!this.processing.has(chatId)) {
				this.processQueue(instance, chatId);
			}
		});
	}

	/**
	 * Processa a fila de um chat específico
	 */
	private async processQueue(_instance: string, chatId: string): Promise<void> {
		this.processing.add(chatId);

		try {
			while (true) {
				const queue = this.queues.get(chatId);
				if (!queue || queue.length === 0) {
					break;
				}

				const message = queue.shift()!;
				Logger.debug(`[MessageQueue] Processando mensagem ${message.id} do chat ${chatId}`);

				// Atualiza status no banco
				await prismaService.messageQueueItem.update({
					where: { id: message.dbId },
					data: {
						status: MessageQueueStatus.PROCESSING,
						processingStartedAt: new Date()
					}
				});

				try {
					const result = await message.execute();

					// Marca como concluída no banco
					await prismaService.messageQueueItem.update({
						where: { id: message.dbId },
						data: {
							status: MessageQueueStatus.COMPLETED,
							processedAt: new Date()
						}
					});

					message.resolve(result);
					Logger.debug(`[MessageQueue] Mensagem ${message.id} processada com sucesso`);
				} catch (error) {
					Logger.error(`[MessageQueue] Erro ao processar mensagem ${message.id}: ${sanitizeErrorMessage(error)}`);

					// Busca configuração de retries
					const dbItem = await prismaService.messageQueueItem.findUnique({
						where: { id: message.dbId }
					});

					if (dbItem && dbItem.retryCount < dbItem.maxRetries) {
						// Tenta novamente
						Logger.info(`[MessageQueue] Reagendando mensagem ${message.id} (tentativa ${dbItem.retryCount + 1}/${dbItem.maxRetries})`);

						await prismaService.messageQueueItem.update({
							where: { id: message.dbId },
							data: {
								status: MessageQueueStatus.PENDING,
								retryCount: dbItem.retryCount + 1,
								error: sanitizeErrorMessage(error),
								processingStartedAt: null
							}
						});

						// Reagenda para tentar novamente
						queue.push(message);
					} else {
						// Falha definitiva
						await prismaService.messageQueueItem.update({
							where: { id: message.dbId },
							data: {
								status: MessageQueueStatus.FAILED,
								error: sanitizeErrorMessage(error),
								processedAt: new Date()
							}
						});

						message.reject(error);
						Logger.error(`[MessageQueue] Mensagem ${message.id} falhou após todas as tentativas`);
					}
				}

				// Pequeno delay entre mensagens do mesmo chat
				if (queue.length > 0) {
					await this.randomDelay();
				}
			}
		} finally {
			this.processing.delete(chatId);

			// Limpa fila vazia
			if (this.queues.get(chatId)?.length === 0) {
				this.queues.delete(chatId);
			}
		}
	}

	/**
	 * Delay aleatório entre mensagens
	 */
	private async randomDelay(): Promise<void> {
		const delay = 500 + Math.random() * 1500; // 0.5s a 2s
		await new Promise((resolve) => setTimeout(resolve, delay));
	}

	/**
	 * Retorna o tamanho da fila de um chat
	 */
	public getQueueSize(chatId: string): number {
		return this.queues.get(chatId)?.length || 0;
	}

	/**
	 * Verifica se um chat está sendo processado
	 */
	public isProcessing(chatId: string): boolean {
		return this.processing.has(chatId);
	}

	/**
	 * Limpa a fila de um chat específico (marca como cancelada no banco)
	 */
	public async clearQueue(_instance: string, chatId: string): Promise<void> {
		const queue = this.queues.get(chatId);
		if (queue) {
			// Marca todas as mensagens da fila como canceladas
			const messageIds = queue.map((msg) => msg.dbId);

			await prismaService.messageQueueItem.updateMany({
				where: {
					id: { in: messageIds }
				},
				data: {
					status: MessageQueueStatus.CANCELLED,
					processedAt: new Date()
				}
			});

			queue.forEach((msg) => {
				msg.reject(new Error("Queue cleared"));
			});
			this.queues.delete(chatId);

			Logger.info(`[MessageQueue] Fila do chat ${chatId} foi limpa (${messageIds.length} mensagens canceladas)`);
		}
	}

	/**
	 * Retorna estatísticas da fila
	 */
	public async getStats(instance: string, clientId: number) {
		const stats = await prismaService.messageQueueItem.groupBy({
			by: ["status"],
			where: {
				instance,
				clientId
			},
			_count: true
		});

		return stats.reduce(
			(acc, stat) => {
				acc[stat.status.toLowerCase()] = stat._count;
				return acc;
			},
			{} as Record<string, number>
		);
	}

	/**
	 * Remove mensagens antigas já processadas (limpeza)
	 */
	public async cleanOldMessages(instance: string, daysOld: number = 7): Promise<number> {
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - daysOld);

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

		Logger.info(`[MessageQueue] Removidas ${result.count} mensagens antigas da instância ${instance}`);
		return result.count;
	}
}

export default MessageQueue;
