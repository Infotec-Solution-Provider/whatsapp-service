import { Request, Response, Router } from "express";
import { BadRequestError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";
import messagesService from "../services/messages.service";
import messagesDistributionService from "../services/messages-distribution.service";
import prismaService from "../services/prisma.service";
import ProcessingLogger from "../utils/processing-logger";
import { Logger } from "@in.pulse-crm/utils";

const ENDPOINT = "/api/whatsapp/parsed-messages";

interface ProcessMessageBody extends CreateMessageDto {
	/** Nome do contato (opcional, usado para criar/atualizar contato) */
	contactName?: string | null;
}

interface ProcessMessageResponse {
	success: boolean;
	message: string;
	data?: {
		messageId: number;
		chatId: number;
		contactId: number;
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

			// Insere a mensagem no banco
			logger.log("Inserindo mensagem no banco");
			const inserted = await messagesService.insertMessage(messageDto);
			logger.log("Mensagem inserida", { messageId: inserted.id });

			// Processa a mensagem (cria chat, distribui, etc)
			logger.log("Processando distribuição da mensagem");
			const processed = await messagesDistributionService.processMessage(
				messageDto.instance,
				messageDto.clientId!,
				inserted,
				contactName
			);

			logger.success("Mensagem processada com sucesso");

			const response: ProcessMessageResponse = {
				success: true,
				message: "Message processed successfully",
				data: {
					messageId: processed.id,
					chatId: processed.chatId!,
					contactId: processed.contactId!
				}
			};

			res.status(201).send(response);
		} catch (err: any) {
			logger.failed(err);
			Logger.error(`Erro ao processar mensagem parseada: ${err?.message}`);

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

					const inserted = await messagesService.insertMessage(messageDto);

					await messagesDistributionService.processMessage(
						messageDto.instance,
						messageDto.clientId!,
						inserted,
						contactName
					);

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
			Logger.error(`Erro ao processar batch de mensagens: ${err?.message}`);

			res.status(err?.statusCode || 500).send({
				success: false,
				message: "Failed to process batch",
				error: err?.message || "Unknown error"
			});
		}
	};
}

export default new ParsedMessagesController(Router());
