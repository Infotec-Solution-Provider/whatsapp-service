import { BadRequestError } from "@rgranatodutra/http-errors";
import ProcessingLogger from "../utils/processing-logger";
import { WABAMessageStatusData } from "../types/whatsapp-api.types";
import GUPSHUPMessageParser from "../parsers/gupshup-message.parser";
import prismaService from "./prisma.service";
import messagesService from "./messages.service";
import mdservice from "./messages-distribution.service";

interface ValidateEntryProps {
	instance: string;
	logger: ProcessingLogger;
	input: any;
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

		if (input.entry[0].changes[0].value?.statuses?.[0]) {
			const statusChange = input.entry[0].changes[0].value.statuses[0];
			logger.log("Recebido status de mensagem", statusChange);

			return {
				type: "status" as const,
				data: statusChange as WABAMessageStatusData,
				appId: input.gs_app_id
			};
		}

		if (input.entry[0].changes[0].value?.messages?.[0]) {
			const message = input.entry[0].changes[0].value.messages[0];
			const recipient = input.entry[0].changes[0].value.metadata.display_phone_number;

			logger.log("Mensagem recebida");
			const parsedMsg = await GUPSHUPMessageParser.parse(recipient, instance, message);
			logger.log("Mensagem parseada com sucesso");

			return {
				type: "message" as const,
				data: parsedMsg,
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
					logger.log("status de mensagem processado com sucesso");
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
}

export default new GupshupService();
