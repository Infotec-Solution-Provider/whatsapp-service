import { BadRequestError } from "@rgranatodutra/http-errors";
import ProcessingLogger from "../utils/processing-logger";
import { WABAMessageStatusData } from "../types/whatsapp-api.types";
import GUPSHUPMessageParser from "../parsers/gupshup-message.parser";
import prismaService from "./prisma.service";
import messagesService from "./messages.service";
import messagesDistributionService from "./messages-distribution.service";

class GupshupService {
	private async validateEntry(
		instance: string,
		logger: ProcessingLogger,
		data: any
	) {
		logger.log("Validando webhook entry", {
			instance,
			gs_app_id: data?.gs_app_id,
			hasEntryValue: Boolean(data?.entry?.[0]?.changes?.[0]?.value)
		});

		if (typeof data !== "object" || data === null) {
			logger.log("Payload não é objeto ou é nulo");
			throw new BadRequestError("invalid webhook entry.");
		}

		if (!data?.entry?.[0]?.changes?.[0]?.value) {
			logger.log("Estrutura entry[0].changes[0].value ausente");
			throw new BadRequestError("invalid webhook entry.");
		}

		if (data.entry[0].changes[0].value?.statuses?.[0]) {
			const statusChange = data.entry[0].changes[0].value.statuses[0];
			logger.log("Recebido status de mensagem", statusChange);

			return {
				type: "status" as const,
				data: statusChange as WABAMessageStatusData,
				appId: data.gs_app_id
			};
		}

		if (data.entry[0].changes[0].value?.messages?.[0]) {
			const message = data.entry[0].changes[0].value.messages[0];
			const recipient =
				data.entry[0].changes[0].value.metadata.display_phone_number;

			logger.log("Mensagem recebida");
			const parsedMsg = await GUPSHUPMessageParser.parse(
				recipient,
				instance,
				message
			);
			logger.log("Mensagem parseada com sucesso");

			return {
				type: "message" as const,
				data: parsedMsg,
				appId: data.gs_app_id
			};
		}

		throw new BadRequestError("Unexpected webhook entry");
	}

	public async handleWebhookEntry(instance: string, data: unknown) {
		const logger = new ProcessingLogger(
			instance,
			"webhook-entry",
			new Date().toISOString(),
			data
		);

		try {
			logger.log("validando webhook entry");
			const entry = await this.validateEntry(instance, logger, data);
			logger.log("webhook entry validado com sucesso", entry);

			logger.log(
				"procurando client para o gupshup app de id " + entry.appId
			);
			const client = await prismaService.wppClient.findFirstOrThrow({
				where: {
					gupshupAppId: entry.appId
				}
			});
			logger.log("encontrado o client de id " + client.id);

			switch (entry.type) {
				case "message":
					logger.log("processando mensagem recebida");
					const savedMsg = await messagesService.insertMessage(
						entry.data
					);
					await messagesDistributionService.processMessage(
						instance,
						client.id,
						savedMsg
					);
					break;
				case "status":
					logger.log("processando status de mensagem recebida");
					const status = GUPSHUPMessageParser.parseStatus(entry.data);

					await messagesDistributionService.processMessageStatus(
						"waba",
						entry.data.gs_id,
						status
					);
					break;
				default:
					logger.failed("entrada desconhecida");
					break;
			}
		} catch (err: any) {
			logger.failed(err);
			throw err;
		}
	}
}

export default new GupshupService();
