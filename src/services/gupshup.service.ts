import { BadRequestError } from "@rgranatodutra/http-errors";
import ProcessingLogger from "../utils/processing-logger";
import GUPSHUPMessageParser from "../parsers/gupshup-message.parser";
import prismaService from "./prisma.service";
import messagesService from "./messages.service";
import mdservice from "./messages-distribution.service";
import { GSBillingEvent, GSMessageStatusData, GSMessageStatusError } from "../types/gupshup-api.types";
import messagesDistributionService from "./messages-distribution.service";
import chatsService from "./chats.service";
import { WppClient } from "@prisma/client";

interface ValidateEntryProps {
	instance: string;
	logger: ProcessingLogger;
	input: any;
}

interface ProcessBillingEventProps {
	logger: ProcessingLogger;
	event: GSBillingEvent;
}

interface ProcessFailedStatusProps {
	logger: ProcessingLogger;
	error: GSMessageStatusError;
	messageId: string;
	client: WppClient;
}

class GupshupService {
	private async validateEntry({ instance, logger, input }: ValidateEntryProps) {
		logger.log("Validando webhook entry", {
			instance,
			gs_app_id: input?.gs_app_id,
			hasEntryValue: Boolean(input?.entry?.[0]?.changes?.[0]?.value)
		});

		if (typeof input !== "object" || input === null) {
			logger.log("Payload não é objeto ou é nulo");
			throw new BadRequestError("invalid webhook entry.");
		}

		if (!input?.entry?.[0]?.changes?.[0]?.value) {
			logger.log("Estrutura entry[0].changes[0].value ausente");
			throw new BadRequestError("invalid webhook entry.");
		}

		const change = input.entry[0].changes[0];

		if (change.value.statuses) {
			const statusChange = change.value.statuses[0];
			logger.log("Recebido status de mensagem", statusChange);

			return {
				type: "status" as const,
				data: statusChange as GSMessageStatusData,
				appId: input.gs_app_id
			};
		}

		if (change.value.messages) {
			const message = change.value.messages[0];
			const recipient = change.value.metadata.display_phone_number;

			logger.log("Mensagem recebida");
			const parsedMsg = await GUPSHUPMessageParser.parse(recipient, instance, message);
			logger.log("Mensagem parseada com sucesso");

			return {
				type: "message" as const,
				data: parsedMsg,
				appId: input.gs_app_id
			};
		}

		if (change.field === "billing-event") {
			logger.log("Recebido evento de cobrança");
			return {
				type: "billing" as const,
				data: change.value as GSBillingEvent,
				appId: input.gs_app_id
			};
		}

		throw new BadRequestError("Unexpected webhook entry");
	}

	public async handleWebhookEntry(instance: string, input: unknown) {
		const logger = new ProcessingLogger(instance, "webhook-entry", new Date().toISOString(), input);

		try {
			logger.log("validando webhook entry");
			const entry = await this.validateEntry({ instance, logger, input });
			const { appId, data, type } = entry;

			logger.log("webhook entry validado com sucesso", entry);
			logger.log(`procurando client para o gupshup app de id ${appId}`);

			const client = await prismaService.wppClient.findFirstOrThrow({
				where: {
					gupshupAppId: entry.appId
				}
			});

			logger.log(`encontrado o client de id ${client.id}`);

			switch (type) {
				case "message":
					logger.log("processando mensagem recebida");
					const msg = await messagesService.insertMessage(data);
					await mdservice.processMessage(instance, client.id, msg);
					logger.log("mensagem processada com sucesso");
					break;
				case "status":
					logger.log("processando status de mensagem recebida");
					const status = GUPSHUPMessageParser.parseStatus(entry.data);
					await mdservice.processMessageStatus("waba", entry.data.gs_id, status);

					if ("errors" in entry.data && entry.data.errors[0]) {
						const error = entry.data.errors[0];
						await this.processFailedStatus({ logger, error, messageId: entry.data.gs_id, client });
					}

					logger.log("status de mensagem processado com sucesso");
					break;
				case "billing":
					logger.log("Processando evento de cobrança");
					await this.processBillingEvent({ logger, event: data });
					break;
				default:
					logger.failed("entrada desconhecida");
					break;
			}
			logger.success("webhook entry processado com sucesso");
		} catch (err: any) {
			logger.failed(err);
			throw err;
		}
	}

	private async processBillingEvent({ logger, event }: ProcessBillingEventProps) {
		try {
			logger.log("Verificando se o evento é faturável...");

			if (event.deductions.billable) {
				logger.log("Evento é faturável, inserindo na base de dados...");
				await prismaService.wppMessage.update({
					where: {
						wabaId: event.references.id
					},
					data: {
						billingCategory: event.deductions.category
					}
				});
				logger.success("Evento de cobrança processado com sucesso!");
			} else {
				logger.log("Evento não é faturável, ignorando.");
			}
		} catch (err: any) {
			logger.log("Erro ao processar evento de cobrança");
			throw err;
		}
	}

	private async processFailedStatus({ logger, error, messageId, client }: ProcessFailedStatusProps) {
		try {
			logger.log("Processando status de falha para a mensagem");
			const message = await prismaService.wppMessage.findUniqueOrThrow({
				where: {
					wabaId: messageId
				},
				include: {
					WppContact: true
				}
			});
			logger.log("Mensagem encontrada, enviando mensagem de erro para o contato");

			if (!message.WppContact) {
				logger.log("Mensagem não tem contato associado, não é possível enviar mensagem de erro");
				throw new Error("Message has no associated contact");
			}

			const contact = message.WppContact;
			const chat = await chatsService.getChatForContact(client.id, contact);

			const systemMessage = `Ocorreu um erro ao enviar a mensagem para o número do WhatsApp.\nCódigo do erro: ${error.code}.\nDescrição: ${error}.\nDetalhes: ${error.href}`;

			await messagesDistributionService.addThirdpartyMessage(
				client.instance,
				systemMessage,
				"META",
				true,
				contact,
				chat,
				message.id
			);
		} catch (err: any) {
			logger.log("Erro ao processar status de falha");
			throw err;
		}
	}
}

export default new GupshupService();
