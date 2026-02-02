import { Formatter } from "@in.pulse-crm/utils";
import { BadRequestError } from "@rgranatodutra/http-errors";
import { Request, Response, Router } from "express";
import CreateMessageDto from "../dtos/create-message.dto";
import contactsService from "../services/contacts.service";
import internalChatsService from "../services/internal-chats.service";
import messageQueueService from "../services/message-queue.service";
import messagesService from "../services/messages.service";
import prismaService from "../services/prisma.service";
import ProcessingLogger from "../utils/processing-logger";

const ENDPOINT = "/api/whatsapp/parsed-messages";

interface ProcessMessageBody extends CreateMessageDto {
	/** Indica se a mensagem veio de grupo */
	isGroup: boolean;
	/** ID do grupo (quando isGroup = true) */
	groupId?: string | null;
	contactName?: string | null;
}

interface ProcessMessageResponse {
	success: boolean;
	message: string;
	data?: {
		messageId: number;
		chatId: number | null;
		contactId: number | null;
		queueId?: string;
	};
	error?: string;
}

class ParsedMessagesController {
	constructor(public readonly router: Router) {
		// Rota para receber uma mensagem parseada
		router.post(ENDPOINT, this.processMessage.bind(this));

		// Rota para receber múltiplas mensagens parseadas em batch
		router.post(ENDPOINT + "/batch", this.processBatch.bind(this));
	}

	/**
	 * Valida campos obrigatórios do CreateMessageDto
	 */
	private validateMessage(data: unknown): ProcessMessageBody {
		if (!data || typeof data !== "object") {
			throw new BadRequestError("Request body must be an object");
		}

		const msg = data as ProcessMessageBody;

		if (!msg.instance) {
			throw new BadRequestError("Field 'instance' is required");
		}

		if (!msg.clientId) {
			throw new BadRequestError("Field 'clientId' is required");
		}

		if (!msg.from) {
			throw new BadRequestError("Field 'from' is required");
		}

		if (!msg.to) {
			throw new BadRequestError("Field 'to' is required");
		}

		if (!msg.type) {
			throw new BadRequestError("Field 'type' is required");
		}

		if (!msg.status) {
			throw new BadRequestError("Field 'status' is required");
		}

		if (typeof msg.isGroup !== "boolean") {
			throw new BadRequestError("Field 'isGroup' must be boolean");
		}

		if (msg.isGroup && !msg.groupId) {
			throw new BadRequestError("Field 'groupId' is required for group messages");
		}

		return msg;
	}

	/**
	 * Processa uma única mensagem parseada
	 */
	private processMessage = async (req: Request, res: Response) => {
		const logger = new ProcessingLogger(
			"parsed-message",
			"process-single",
			Date.now().toString(),
			req.body
		);

		try {
			logger.log("Recebendo mensagem parseada");

			const { contactName, ...messageDto } = this.validateMessage(req.body);
			logger.log("Mensagem validada", messageDto);

			// Verifica se o client existe
			const client = await prismaService.wppClient.findUnique({
				where: { id: messageDto.clientId! }
			});

			if (!client) {
				throw new BadRequestError(`Client with ID ${messageDto.clientId} not found`);
			}

			if (client.instance !== messageDto.instance) {
				throw new BadRequestError(
					`Client instance mismatch: expected '${client.instance}', got '${messageDto.instance}'`
				);
			}

			// Mensagens de grupo devem ir para o handler interno
			if (messageDto.isGroup && messageDto.groupId) {
				logger.log("Mensagem de grupo detectada, processando em internalChatsService");
				const savedMsg = await internalChatsService.receiveMessage(
					messageDto.groupId,
					messageDto,
					contactName
				);
				logger.success("Mensagem de grupo processada com sucesso");

				const response: ProcessMessageResponse = {
					success: true,
					message: "Group message processed successfully",
					data: {
						messageId: savedMsg?.id || 0,
						chatId: null,
						contactId: null
					}
				};

				res.status(201).send(response);
				return;
			}

			// Verifica se é uma mensagem enviada pelo operador (from começa com "me:")
			if (messageDto.from.startsWith("me:")) {
				logger.log("Mensagem enviada pelo operador detectada, buscando contato pelo destinatário");

				// Busca o contato pelo número de destino (to)
				const contact = await contactsService.getOrCreateContact(
					messageDto.instance,
					contactName || Formatter.phone(messageDto.to),
					messageDto.to
				);
				logger.log("Contato encontrado", { contactId: contact.id });

				// Insere a mensagem com o contactId, sem processar distribuição
				const inserted = await messagesService.insertMessage({
					...messageDto,
					contactId: contact.id
				});
				logger.log("Mensagem inserida (sem distribuição)", { messageId: inserted.id });
				logger.success("Mensagem do operador salva com sucesso");

				const response: ProcessMessageResponse = {
					success: true,
					message: "Operator message saved successfully (no distribution)",
					data: {
						messageId: inserted.id,
						chatId: inserted.chatId || 0,
						contactId: contact.id
					}
				};

				res.status(201).send(response);
				return;
			}

			// Insere a mensagem no banco
			logger.log("Inserindo mensagem no banco");
			const inserted = await messagesService.insertMessage(messageDto);
			logger.log("Mensagem inserida", { messageId: inserted.id });

			// Enfileira a mensagem para processamento pela fila
			logger.log("Enfileirando mensagem para processamento");
			const queueId = await messageQueueService.enqueue({
				instance: messageDto.instance,
				clientId: messageDto.clientId!,
				messageId: inserted.id,
				contactPhone: inserted.from,
				contactName: contactName
			});
			logger.log("Mensagem enfileirada", { queueId });
			logger.success("Mensagem enfileirada com sucesso");

			const response: ProcessMessageResponse = {
				success: true,
				message: "Message queued for processing",
				data: {
					messageId: inserted.id,
					chatId: null,
					contactId: null
				}
			};

			res.status(201).send(response);
		} catch (err: any) {
			logger.failed(err);

			const response: ProcessMessageResponse = {
				success: false,
				message: "Failed to process message",
				error: err?.message || "Unknown error"
			};

			const statusCode = err?.statusCode || 500;
			res.status(statusCode).send(response);
		}
	};

	/**
	 * Processa múltiplas mensagens parseadas em batch
	 */
	private processBatch = async (req: Request, res: Response) => {
		const logger = new ProcessingLogger(
			"parsed-message",
			"process-batch",
			Date.now().toString(),
			{ count: Array.isArray(req.body) ? req.body.length : 0 }
		);

		try {
			if (!Array.isArray(req.body)) {
				throw new BadRequestError("Request body must be an array of messages");
			}

			const messages = req.body as unknown[];
			logger.log(`Processando batch de ${messages.length} mensagens`);

			const results: Array<{
				index: number;
				success: boolean;
				messageId?: number;
				error?: string;
			}> = [];

			// Processa cada mensagem sequencialmente para manter ordem
			for (let i = 0; i < messages.length; i++) {
				try {
					const { contactName, ...messageDto } = this.validateMessage(messages[i]);

					// Verifica se o client existe
					const client = await prismaService.wppClient.findUnique({
						where: { id: messageDto.clientId! }
					});

					if (!client) {
						throw new BadRequestError(`Client with ID ${messageDto.clientId} not found`);
					}

					if (client.instance !== messageDto.instance) {
						throw new BadRequestError(
							`Client instance mismatch: expected '${client.instance}', got '${messageDto.instance}'`
						);
					}

					// Mensagens de grupo devem ir para o handler interno
					if (messageDto.isGroup && messageDto.groupId) {
						await internalChatsService.receiveMessage(messageDto.groupId, messageDto, contactName);
						results.push({
							index: i,
							success: true
						});
						continue;
					}

					// Verifica se é uma mensagem enviada pelo operador (from começa com "me:")
					if (messageDto.from.startsWith("me:")) {
						// Busca o contato pelo número de destino (to)
						const contact = await contactsService.getOrCreateContact(
							messageDto.instance,
							contactName || Formatter.phone(messageDto.to),
							messageDto.to
						);

						// Insere a mensagem com o contactId, sem processar distribuição
						const inserted = await messagesService.insertMessage({
							...messageDto,
							contactId: contact.id
						});

						results.push({
							index: i,
							success: true,
							messageId: inserted.id
						});
						continue;
					}

					const inserted = await messagesService.insertMessage(messageDto);

					// Enfileira a mensagem para processamento
					await messageQueueService.enqueue({
						instance: messageDto.instance,
						clientId: messageDto.clientId!,
						messageId: inserted.id,
						contactPhone: inserted.from,
						contactName: contactName
					});

					results.push({
						index: i,
						success: true,
						messageId: inserted.id
					});
				} catch (err: any) {
					results.push({
						index: i,
						success: false,
						error: err?.message || "Unknown error"
					});
				}
			}

			const successCount = results.filter((r) => r.success).length;
			const failCount = results.filter((r) => !r.success).length;

			logger.log(`Batch processado: ${successCount} sucesso, ${failCount} falhas`);
			logger.success("Batch finalizado");

			res.status(200).send({
				success: failCount === 0,
				message: `Processed ${successCount}/${messages.length} messages successfully`,
				results
			});
		} catch (err: any) {
			logger.failed(err);

			res.status(err?.statusCode || 500).send({
				success: false,
				message: "Failed to process batch",
				error: err?.message || "Unknown error"
			});
		}
	};
}

export default new ParsedMessagesController(Router());
