import { WppClient } from "@prisma/client";
import { BadRequestError } from "@rgranatodutra/http-errors";
import WABAMessageParser from "../parsers/waba-message.parser";
import { Message, ReceiveMessageBody, WABAMessageStatusData } from "../types/whatsapp-api.types";
import ProcessingLogger from "../utils/processing-logger";
import chatsService from "./chats.service";
import messagesDistributionService from "./messages-distribution.service";
import messagesService from "./messages.service";
import prismaService from "./prisma.service";

interface ValidateEntryResultStatus {
	type: "status";
	data: WABAMessageStatusData;
	appId: string | undefined;
}

interface ValidateEntryResultMessage {
	type: "message";
	data: Message;
	appId: string | undefined;
	recipient: string;
}

type ValidateEntryResult = ValidateEntryResultStatus | ValidateEntryResultMessage;

class WABAService {
	private async validateEntry(
		_instance: string,
		logger: ProcessingLogger,
		input: unknown
	): Promise<ValidateEntryResult> {
		logger.log("Validando webhook entry");

		if (typeof input !== "object" || input === null) {
			throw new BadRequestError("invalid webhook entry.");
		}

		const body = input as ReceiveMessageBody;
		const entry = body.entry?.[0];
		const change = entry?.changes?.[0];
		const value = change?.value as unknown as
			| ReceiveMessageBody["entry"][number]["changes"][number]["value"]
			| undefined;

		if (!value) {
			throw new BadRequestError("invalid webhook entry.");
		}

		const recipient = value?.metadata?.display_phone_number;

		if (value.statuses && value.statuses[0]) {
			const statusData = value.statuses[0] as WABAMessageStatusData;
			logger.log("Identificado como status de mensagem: " + statusData.status);
			return { type: "status", data: statusData, appId: undefined };
		}

		if (value.messages && value.messages[0]) {
			const message = value.messages[0] as Message;
			logger.log("Identificado como mensagem do tipo " + message.type);
			return { type: "message", data: message, appId: undefined, recipient };
		}

		throw new BadRequestError("Unexpected webhook entry");
	}

	public async handleWebhookEntry(instance: string, input: unknown) {
		const logger = new ProcessingLogger(instance, "waba-webhook-entry", Date.now().toString(), input);

		try {
			logger.log("Iniciando processamento do webhook WABA");
			const validated = await this.validateEntry(instance, logger, input);
			logger.log("Webhook validado", validated);

			// Encontrar client WABA pela instance
			const client = await prismaService.wppClient.findFirstOrThrow({
				where: {
					instance,
					type: "WABA"
				}
			});
			logger.log("Client WABA encontrado. id: " + client.id);

			switch (validated.type) {
				case "message":
					logger.processName += "/message";
					logger.log("Processando mensagem WABA");
					const parsedMsg = await WABAMessageParser.parse(
						validated.recipient,
						instance,
						validated.data,
						logger
					);
					const inserted = await messagesService.insertMessage(parsedMsg);
					const processed = await messagesDistributionService.processMessage(instance, client.id, inserted);
					if (processed.contactId) {
						logger.log("Verificando necessidade de atualizar expiration da conversa");
						const isUpdated = await this.checkAndUpdateContactConversationExpiration(
							logger,
							processed.contactId,
							+parsedMsg.timestamp
						);

						if (isUpdated) {
							logger.log("Expiration da conversa atualizada com sucesso!");
						} else {
							logger.log("Nenhuma atualização na expiration da conversa.");
						}
					}

					logger.log("Mensagem WABA processada com sucesso");
					break;
				case "status":
					logger.processName += "/status";
					logger.log("Processando status WABA");
					const status = WABAMessageParser.parseStatus(validated.data);
					await messagesDistributionService.processMessageStatus("waba", validated.data.id, status);

					if (validated.data.errors && validated.data.errors[0]) {
						const error = validated.data.errors[0];
						await this.processFailedStatus({ logger, statusData: validated.data, error, client });
					}

					if (validated.data.conversation && validated.data.conversation.expiration_timestamp) {
						await this.processConversationState({
							logger,
							statusData: validated.data,
							client
						});
					}
					logger.log("Status WABA processado");
					break;
				default:
					logger.processName += "/unknown";
					logger.failed("Tipo de entrada desconhecido");
			}

			logger.success("Webhook WABA processado com sucesso");
		} catch (err: any) {
			logger.failed(err);
			throw err;
		}
	}

	// private async downloadAndStoreFile(instance: string, url: string, mime: string, filename?: string) {
	//   // Implementação futura
	// }

	private async processFailedStatus({
		logger,
		statusData,
		error,
		client
	}: {
		logger: ProcessingLogger;
		statusData: WABAMessageStatusData;
		error: { code: number; title: string; message: string; error_data?: { details: string } };
		client: WppClient;
	}) {
		try {
			logger.log("Processando status de falha WABA", { messageId: statusData.id });
			const message = await prismaService.wppMessage.findFirst({
				where: { OR: [{ wabaId: statusData.id }, { gupshupId: statusData.id }] },
				include: { WppContact: true }
			});
			if (!message || !message.WppContact) {
				logger.log("Mensagem ou contato não encontrado para processar falha");
				return;
			}
			const contact = message.WppContact;
			const chat = await chatsService.getChatForContact(client.id, contact);
			const systemMessage = `Ocorreu um erro ao enviar a mensagem para o número do WhatsApp.\nCódigo do erro: ${error.code}.\nDescrição: ${error.message}.`;
			await messagesDistributionService.addThirdpartyMessage(
				client.instance,
				systemMessage,
				"META",
				true,
				contact,
				chat,
				message.id
			);
		} catch (err) {
			logger.log("Erro ao processar status de falha WABA");
		}
	}

	private async processConversationState({
		logger,
		statusData
	}: {
		logger: ProcessingLogger;
		statusData: WABAMessageStatusData;
		client: WppClient;
	}) {
		try {
			if (!statusData.conversation?.expiration_timestamp) return;
			logger.log("Atualizando expiration da conversa", {
				expiration: statusData.conversation.expiration_timestamp
			});

			const message = await prismaService.wppMessage.findFirst({
				where: { wabaId: statusData.id },
				include: { WppContact: true }
			});
			if (!message?.WppContact) return;

			await prismaService.wppContact.update({
				where: { id: message.WppContact.id },
				data: { conversationExpiration: statusData.conversation.expiration_timestamp + "000" }
			});
		} catch (err) {
			logger.log("Erro ao processar estado de conversa WABA");
		}
	}

	private async checkAndUpdateContactConversationExpiration(
		process: ProcessingLogger,
		contactId: number,
		messageTimestamp: number
	) {
		process.log("Verificando necessidade de atualizar expiration da conversa");
		let isUpdated = false;

		const contact = await prismaService.wppContact.findUnique({
			where: { id: contactId }
		});
		if (!contact) {
			process.log("Contato não encontrado ao verificar expiration da conversa");
			return;
		}
		process.log("Contato encontrado", contact);
		const curExpirationTime = contact.conversationExpiration ? Number(contact.conversationExpiration) : null;
		const isContactWindowExpired = !curExpirationTime || Date.now() > curExpirationTime;
		const isMessageWithinWindow = curExpirationTime ? messageTimestamp < curExpirationTime : false;

		process.log("Verificando janelas de tempo", {
			isContactWindowExpired,
			isMessageWithinWindow,
			expiration: curExpirationTime,
			messageTimestamp
		});

		if (isContactWindowExpired && !isMessageWithinWindow) {
			process.log("Atualizando expiration da conversa");
			const currMessageDate = new Date(messageTimestamp);
			const updatedExpiration = new Date(currMessageDate.getTime() + 24 * 60 * 60 * 1000).getTime().toString();

			await prismaService.wppContact.update({
				where: { id: contactId },
				data: { conversationExpiration: updatedExpiration }
			});
			process.log("Expiration da conversa atualizada", { contactId, updatedExpiration });
			isUpdated = true;
		}
		process.log("Verificação de atualização da expiration da conversa concluída", { isUpdated });
		return isUpdated;
	}
}

export default new WABAService();
