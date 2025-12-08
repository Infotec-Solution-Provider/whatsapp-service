import { SessionData } from "@in.pulse-crm/sdk";
import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { InternalMessage, WppMessage } from "@prisma/client";
import { BadRequestError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";
import { SendFileOptions, SendFileType, SendMessageOptions } from "../types/whatsapp-instance.types";
import ProcessingLogger from "../utils/processing-logger";
import GupshupWhatsappClient from "../whatsapp-client/gupshup-whatsapp-client";
import WABAWhatsappClient from "../whatsapp-client/waba-whatsapp-client";
import WhatsappClient from "../whatsapp-client/whatsapp-client";
import WWEBJSWhatsappClient from "../whatsapp-client/wwebjs-whatsapp-client";
import filesService from "./files.service";
import internalChatsService from "./internal-chats.service";
import messagesDistributionService from "./messages-distribution.service";
import messagesService from "./messages.service";
import prismaService from "./prisma.service";
import whatsappService from "./whatsapp.service";

interface WhatsappForwardTarget {
	id: string;
	isGroup: boolean;
}

interface InternalForwardTarget {
	id: number;
}

interface ForwardMessagesParams {
	session: SessionData;
	messageIds: number[];
	sourceType: "whatsapp" | "internal";
	whatsappTargets?: WhatsappForwardTarget[];
	internalTargets?: InternalForwardTarget[];
}

interface ForwardToWhatsappParams {
	session: SessionData;
	originalMessages: Array<WppMessage | InternalMessage>;
	sourceType: "whatsapp" | "internal";
	whatsappTargets: WhatsappForwardTarget[];
	client: WhatsappClient;
	logger: ProcessingLogger;
}

interface ForwardToInternalParams {
	session: SessionData;
	originalMessages: Array<WppMessage | InternalMessage>;
	sourceType: "whatsapp" | "internal";
	internalTargets: InternalForwardTarget[];
	logger: ProcessingLogger;
}

interface SaveForwardedMessageParams {
	session: SessionData;
	originalMessage: WppMessage | InternalMessage;
	target: WhatsappForwardTarget;
	client: WhatsappClient;
	logger: ProcessingLogger;
}

class MessageForwardingService {
	public async forwardMessages(params: ForwardMessagesParams): Promise<void> {
		const { session, messageIds, sourceType, whatsappTargets = [], internalTargets = [] } = params;

		const logger = new ProcessingLogger(
			session.instance,
			"forward-messages",
			`user:${session.userId}-${Date.now()}`,
			{
				messageCount: messageIds.length,
				whatsappTargetCount: whatsappTargets.length,
				internalTargetCount: internalTargets.length,
				sourceType
			}
		);

		try {
			logger.log("Iniciando processo de encaminhamento de mensagens");

			const originalMessages = await this.fetchOriginalMessages(sourceType, messageIds, logger);

			if (originalMessages.length === 0) {
				logger.log("Nenhuma mensagem original encontrada para encaminhar");
				return;
			}

			// Só busca client se houver targets do WhatsApp
			let client: WhatsappClient | null = null;
			if (whatsappTargets.length > 0) {
				client = await this.getWhatsappClient(session);
			}

			await Promise.allSettled([
				whatsappTargets.length > 0
					? this.forwardToWhatsapp({
							session,
							originalMessages,
							sourceType,
							whatsappTargets,
							client: client!,
							logger
						})
					: Promise.resolve(),
				internalTargets.length > 0
					? this.forwardToInternal({
							session,
							originalMessages,
							sourceType,
							internalTargets,
							logger
						})
					: Promise.resolve()
			]);

			logger.success("Processo de encaminhamento concluído");
		} catch (error) {
			logger.failed(`Erro no processo de encaminhamento: ${sanitizeErrorMessage(error)}`);
			throw error;
		}
	}

	private async fetchOriginalMessages(
		sourceType: "whatsapp" | "internal",
		messageIds: number[],
		logger: ProcessingLogger
	): Promise<Array<WppMessage | InternalMessage>> {
		logger.log(`Buscando ${messageIds.length} mensagens originais do tipo: ${sourceType}`);

		if (sourceType === "whatsapp") {
			return await prismaService.wppMessage.findMany({
				where: { id: { in: messageIds } }
			});
		}

		return await prismaService.internalMessage.findMany({
			where: { id: { in: messageIds } }
		});
	}

	private async getWhatsappClient(session: SessionData): Promise<WhatsappClient> {
		const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });

		if (!sector || !sector.defaultClientId) {
			throw new BadRequestError("Nenhum cliente WhatsApp padrão configurado para o setor do usuário.");
		}
		const client = await whatsappService.getClient(sector.defaultClientId);

		if (!client) {
			throw new BadRequestError("Nenhum cliente WhatsApp encontrado para o setor especificado.");
		}

		return client;
	}

	private getClientType(client: WhatsappClient): "WWEBJS" | "WABA" | "GUPSHUP" {
		if (client instanceof WWEBJSWhatsappClient) return "WWEBJS";
		if (client instanceof WABAWhatsappClient) return "WABA";
		if (client instanceof GupshupWhatsappClient) return "GUPSHUP";
		throw new Error("Tipo de cliente não reconhecido");
	}

	private async forwardToWhatsapp(params: ForwardToWhatsappParams): Promise<void> {
		const { whatsappTargets, client, logger } = params;

		if (whatsappTargets.length === 0) {
			logger.log("Nenhum alvo do WhatsApp especificado, pulando encaminhamento para WhatsApp");
			return;
		}

		const clientType = this.getClientType(client);
		logger.log(
			`Iniciando encaminhamento para ${whatsappTargets.length} alvos do WhatsApp usando client ${clientType}`
		);

		for (const target of whatsappTargets) {
			try {
				await this.forwardToSingleWhatsappTarget({ ...params, target });
			} catch (error) {
				logger.log(`Falha ao encaminhar para ${target.id}: ${sanitizeErrorMessage(error)}`);
			}
		}
	}

	private async forwardToSingleWhatsappTarget(
		params: ForwardToWhatsappParams & { target: WhatsappForwardTarget }
	): Promise<void> {
		const { session, originalMessages, sourceType, target, client, logger } = params;

		for (const originalMessage of originalMessages) {
			try {
				const savedMessage = await this.saveForwardedMessage({
					session,
					originalMessage,
					target,
					client,
					logger
				});

				await this.sendForwardedMessage(sourceType, originalMessage, target, client);

				logger.log(
					`Mensagem ID:${originalMessage.id} encaminhada com sucesso para ${target.id}. Novo ID: ${savedMessage.id}`
				);
			} catch (error) {
				logger.log(`Erro ao encaminhar mensagem ID:${originalMessage.id}: ${sanitizeErrorMessage(error)}`);
			}
		}
	}

	private async getOrCreateContactAndChat(instance: string, targetId: string) {
		const contact = await prismaService.wppContact.findUnique({
			where: {
				instance_phone: {
					instance,
					phone: targetId
				}
			}
		});

		const chat = contact
			? await prismaService.wppChat.findFirst({
					where: {
						instance,
						contactId: contact.id
					}
				})
			: null;

		return { contact, chat };
	}

	private async saveForwardedMessage(params: SaveForwardedMessageParams): Promise<WppMessage> {
		const { session, originalMessage, target, client, logger } = params;

		const { contact, chat } = await this.getOrCreateContactAndChat(session.instance, target.id);

		const now = new Date();
		const messageToSave: CreateMessageDto = {
			instance: session.instance,
			status: "SENT",
			timestamp: now.getTime().toString(),
			sentAt: now,
			from: `me:${client._phone}`,
			to: target.id,
			type: originalMessage.type,
			body: originalMessage.body,
			isForwarded: true,
			contactId: contact?.id ?? null,
			chatId: chat?.id ?? null,
			fileId: originalMessage.fileId,
			fileName: originalMessage.fileName,
			fileType: originalMessage.fileType,
			fileSize: originalMessage.fileSize,
			clientId: client.id
		};

		const savedMessage = await messagesService.insertMessage(messageToSave);
		messagesDistributionService.notifyMessage(logger, savedMessage);

		return savedMessage;
	}

	private async sendForwardedMessage(
		sourceType: "whatsapp" | "internal",
		originalMessage: WppMessage | InternalMessage,
		target: WhatsappForwardTarget,
		client: WhatsappClient
	): Promise<void> {
		if (sourceType === "internal") {
			await this.sendInternalMessageAsNew(originalMessage, target, client);
		} else {
			await this.sendWhatsappMessageForward(originalMessage as WppMessage, target, client);
		}
	}

	private async sendWhatsappMessageForward(
		originalMessage: WppMessage,
		target: WhatsappForwardTarget,
		client: WhatsappClient
	): Promise<void> {
		const clientType = this.getClientType(client);
		let messageId: string | null;

		// Determina qual ID usar baseado no tipo do client
		switch (clientType) {
			case "WWEBJS":
				messageId = originalMessage.wwebjsId;
				break;

			case "WABA":
				messageId = originalMessage.wabaId;
				break;
			case "GUPSHUP":
				messageId = originalMessage.gupshupId;
				break;

			default:
				throw new Error(`Tipo de cliente não suportado: ${clientType}`);
		}
		if (!messageId) {
			throw new Error(`Mensagem original não possui ID válido para o cliente ${clientType}`);
		}

		await client.forwardMessage(target.id, messageId, target.isGroup);
	}

	private async sendInternalMessageAsNew(
		originalMessage: WppMessage | InternalMessage,
		target: WhatsappForwardTarget,
		client: WhatsappClient
	): Promise<void> {
		const options = {
			to: target.id,
			text: originalMessage.body || undefined
		} as SendMessageOptions | SendFileOptions;

		if (originalMessage.fileId) {
			(options as SendFileOptions).fileUrl = filesService.getFileDownloadUrl(originalMessage.fileId);
			(options as SendFileOptions).fileName = originalMessage.fileName!;
			(options as SendFileOptions).fileType = originalMessage.fileType! as SendFileType;
			(options as SendFileOptions).sendAsAudio = originalMessage.type === "ptt";
			(options as SendFileOptions).sendAsDocument = originalMessage.type === "document";
		}

		await client.sendMessage(options);
	}

	private async forwardToInternal(params: ForwardToInternalParams): Promise<void> {
		const { internalTargets, session, originalMessages, sourceType, logger } = params;

		if (internalTargets.length === 0) {
			logger.log("Nenhum alvo interno especificado, pulando encaminhamento para chats internos");
			return;
		}

		try {
			logger.log(`Iniciando encaminhamento para ${internalTargets.length} alvos internos`);

			await internalChatsService.forwardWppMessagesToInternal(
				session,
				originalMessages,
				sourceType,
				internalTargets.map((target) => target.id)
			);

			logger.log("Encaminhamento para alvos internos concluído com sucesso");
		} catch (error) {
			logger.log(`Erro no encaminhamento para chats internos: ${sanitizeErrorMessage(error)}`);
			throw error;
		}
	}
}

export default new MessageForwardingService();
