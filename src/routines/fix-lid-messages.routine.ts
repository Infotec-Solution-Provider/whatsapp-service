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
		}
	});

	const uniqueFromMessages = new Map<string, (typeof messagesWithLID)[number]>();

	for (const msg of messagesWithLID) {
		if (!uniqueFromMessages.has(msg.from)) {
			uniqueFromMessages.set(msg.from, msg);
		}
	}

	for (const from of uniqueFromMessages.keys()) {
		const message = uniqueFromMessages.get(from)!;
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

			/* 
            Wrong form: external:120363402687639158:143804548006066@lid
            Correct form: external:120363402687639158:551999999999
            */

			const correctFrom = `external:${contact.number}:${contact.name || contact.pushname || contact.verifiedName || contact.number}`;
			Logger.debug(`Atualizando from de ${message.from} para ${correctFrom}`);
			await prismaService.internalMessage.updateMany({
				where: {
					instance,
					from: message.from
				},
				data: {
					from: correctFrom
				}
			});
			Logger.info(`Mensagem ${message.id} atualizada de ${message.from} para ${correctFrom}`);
		} catch (err) {
			Logger.error(`Erro ao processar mensagem ${message.id}: ${err}`);
			continue;
		}
	}
}

export default runFixLidMessagesRoutine;
