import { User } from "@in.pulse-crm/sdk";
import instancesService from "../services/instances.service";
import prismaService from "../services/prisma.service";
import { Logger } from "@in.pulse-crm/utils";

async function fixMessagesUserId(instance: string) {
	Logger.info("Iniciando rotina para corrigir userId das mensagens para " + instance);
	const query = `SELECT * FROM operadores`;
	const users = await instancesService.executeQuery<Array<User>>(instance, query, []);
	Logger.info(`Usuários carregados: ${users.length}`);

	const messagesWithoutUserId = await prismaService.wppMessage.findMany({
		where: {
			userId: null
		},
		include: {
			WppChat: true
		}
	});
	Logger.info(`Mensagens sem userId encontradas: ${messagesWithoutUserId.length}`);

	let count = 0;
	let failCount = 0;

	for (const message of messagesWithoutUserId) {
		try {
			count++;
			Logger.info(`Processando mensagem ${count} de ${messagesWithoutUserId.length}....`);
			const text = message.body.split(":")[0] || "";
			const userName = text.replaceAll("*", "");
			const possibleUsers = users.filter((user) => user.NOME === userName);
			const user = possibleUsers.length > 0 ? possibleUsers[0] : null;

			if (user) {
				Logger.info(`Sucesso: Encontrou o usuário ${user.NOME} pela mensagem ${text} ...`);
				await prismaService.wppMessage.update({
					where: {
						id: message.id
					},
					data: {
						userId: user.CODIGO
					}
				});
			} else if (message.WppChat?.userId) {
				Logger.info(`Sucesso: Encontrou o usuário ${message.WppChat.userId} via WppChat`);
				await prismaService.wppMessage.update({
					where: {
						id: message.id
					},
					data: {
						userId: message.WppChat.userId
					}
				});
			} else {
				Logger.info(`Não foi possível associar userId ao message.id ${message.id}`);
			}
		} catch (err: any) {
			Logger.error(`Erro ao processar mensagem ${message.id}`, err);
		}
	}
	Logger.info(`Rotina finalizada. Total de mensagens processadas: ${count} | Falhas: ${failCount}`);
}

async function fixMessagesUserIdAllInstances() {
	const instances = ["nunes", "vollo", "exatron", "infotec"];

	for (const instance of instances) {
		await fixMessagesUserId(instance);
	}
}

export default fixMessagesUserIdAllInstances;
