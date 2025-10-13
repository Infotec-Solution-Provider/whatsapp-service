import WAWebJS from "whatsapp-web.js";
import prismaService from "../services/prisma.service";
import { Logger } from "@in.pulse-crm/utils";

async function runFixLidMessagesRoutine(instance: string, client: WAWebJS.Client) {
	const messagesWithLID = await prismaService.internalMessage.findMany({
		where: {
			instance,
			from: {
				contains: "@lid"
			}
		},
		include: {
			chat: {
				select: {
					wppGroupId: true
				}
			}
		}
	});

	for (const message of messagesWithLID) {
		try {
			if (!message.wwebjsId) {
				Logger.debug(`Mensagem ${message.id} sem wwebjsId, pulando...`);
				continue;
			}

			const wwebjsMessage = await client.getMessageById(message.wwebjsId);
			if (!wwebjsMessage) {
				Logger.debug(`Mensagem wwebjs ${message.wwebjsId} não encontrada, pulando...`);
				continue;
			}

			const contact = await wwebjsMessage.getContact();
			if (!contact) {
				Logger.debug(`Contato da mensagem wwebjs ${message.wwebjsId} não encontrado, pulando...`);
				continue;
			}

			const correctFrom = contact.number;
			Logger.debug(`Atualizando mensagem ${message.id} de ${message.from} para ${correctFrom}`);
		} catch (err) {
			Logger.error(`Erro ao processar mensagem ${message.id}: ${err}`);
			continue;
		}
	}
}

export default runFixLidMessagesRoutine;
