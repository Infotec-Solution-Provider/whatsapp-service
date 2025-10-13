import { Parameter, WppChat } from "@prisma/client";
import prismaService from "../services/prisma.service";
import chooseSectorBot from "../bots/choose-sector.bot";
import { Logger } from "@in.pulse-crm/utils";
import chatsService from "../services/chats.service";

interface MessageLike {
	sentAt: Date;
	from: string;
}

const ROUTINE_PARAMETERS = [
	"chat_auto_finish_enabled", // Habilita a rotina se estiver como true
	"chat_auto_finish_idle_time" // Define o tempo em minutos para considerar um chat como ocioso
];

const DEFAULT_CHAT_IDLE_TIME = 30 * 60 * 1000; // minutos

export default async function runIdleChatsRoutine() {
	const parameters = await getRoutineParameters();
	const enabledInstances = await getRoutineEnabledInstances(parameters);
	const ongoingChats = await getOngoingChats(enabledInstances);

	for (const chat of ongoingChats) {
		const chatParameters = await getRoutineParametersForChat(parameters, chat);

		if (chatParameters["chat_auto_finish_enabled"] !== "true") continue;

		const idleTime = Number(chatParameters["chat_auto_finish_idle_time"] || DEFAULT_CHAT_IDLE_TIME);
		Logger.debug(`Usando tempo de inatividade de ${idleTime / 60000} minutos para o chat ${chat.id}`);

		const isIdle = checkIsIdle(chat.startedAt!, chat.messages, idleTime);
		if (!isIdle) {
			Logger.debug(`Chat ${chat.id} não está ocioso. Ultima mensagem em ${chat.messages[0]?.sentAt}`);
			continue;
		}

		Logger.info(`Chat ${chat.id} está ocioso há mais de ${idleTime / 60000} minutos.`);

		const hasUserMsg = await checkHasUserMessage(chat.messages);

		if (!chat.contact) {
			Logger.info(`Chat ${chat.id} está ocioso, mas o contato foi excluído. Finalizando chat.`);
			await finishChatAndNotify(chat, "contato excluído.");
			return;
		}

		if (!hasUserMsg) {
			Logger.info(`Chat ${chat.id} está ocioso e sem mensagens do usuário. Finalizando chat.`);
			await finishChatAndNotify(chat, "inatividade do usuário.", chat.contact?.name);
			return;
		}

		const alreadySentQuestion = chooseSectorBot.checkIfAlreadyAskedToBackToMenu(chat);

		if (!alreadySentQuestion) {
			Logger.info(`Chat ${chat.id} está ocioso. Enviando mensagem para o contato.`);
			await chooseSectorBot.askIfWantsToBackToMenu(chat, chat.contact);
			return;
		}

		const timeSinceQuestion = Date.now() - (chat.messages[0]?.sentAt.getTime() || 0);
		if (timeSinceQuestion > 15 * 60 * 1000) {
			Logger.info(`Chat ${chat.id} está ocioso e já enviou a pergunta. Finalizando chat.`);
			await finishChatAndNotify(chat, "Inatividade após a pergunta do bot.", chat.contact?.name);
			return;
		}
	}
}

async function getRoutineEnabledInstances(parameters: Parameter[]) {
	const enabledInstances: string[] = [];

	parameters.forEach((param) => {
		if (
			param.key === "chat_auto_finish_enabled" &&
			param.value === "true" &&
			param.scope === "INSTANCE" &&
			param.instance
		) {
			enabledInstances.push(param.instance);
		}
	});

	Logger.debug(`[ROUTINE] Instâncias com a rotina habilitada: `, enabledInstances);

	return enabledInstances;
}

async function getOngoingChats(instances: string[]) {
	return prismaService.wppChat.findMany({
		where: {
			isFinished: false,
			instance: { in: instances },
			contactId: { not: null }
		},
		include: {
			messages: {
				select: {
					sentAt: true,
					from: true
				},
				orderBy: { sentAt: "desc" },
				where: {
					sentAt: {
						gte: new Date(Date.now() - 1000 * 60 * 60 * 24) // últimas 24 horas
					}
				}
			},
			contact: true
		}
	});
}

async function getRoutineParameters() {
	return prismaService.parameter.findMany({
		where: {
			key: { in: ROUTINE_PARAMETERS }
		}
	});
}

async function getRoutineParametersForChat(parameters: Parameter[], chat: WppChat) {
	const chatParameters: { [key: string]: string | null } = {};

	const instanceParams = parameters.filter((param) => param.scope === "INSTANCE" && param.instance === chat.instance);
	const sectorParams = parameters.filter((param) => param.scope === "SECTOR" && param.sectorId === chat.sectorId);
	const userParams = parameters.filter((param) => param.scope === "USER" && param.userId === chat.userId);

	instanceParams.forEach((param) => {
		chatParameters[param.key] = param.value;
	});
	sectorParams.forEach((param) => {
		chatParameters[param.key] = param.value;
	});
	userParams.forEach((param) => {
		chatParameters[param.key] = param.value;
	});

	Logger.debug(`[ROUTINE] Parâmetros para o chat ${chat.id}: `, chatParameters);

	return chatParameters;
}

async function checkHasUserMessage(messages: MessageLike[]) {
	return messages.some((m) => m.from.startsWith("me:"));
}

async function finishChatAndNotify(chat: WppChat, reason: string, contactName: string = "CONTATO_EXCLUIDO") {
	Logger.info(`Finalizando chat de ${contactName} | ${reason}`);
	await prismaService.notification.create({
		data: {
			instance: chat.instance,
			title: "Atendimento finalizado automaticamente",
			description: `O chat com ${contactName}, foi finalizado por inatividade do operador.`,
			chatId: chat.id,
			type: "CHAT_AUTO_FINISHED",
			userId: chat.userId ?? null
		}
	});

	await chatsService.systemFinishChatById(chat.id, reason);
}

function checkIsIdle(startedAt: Date, messages: MessageLike[], idleTime: number) {
	const now = Date.now();
	const lastMessageTime = messages[0]?.sentAt.getTime() || 0;

	const idleDuration = now - lastMessageTime;
	const chatDuration = now - startedAt.getTime();
	const isChatIdle = idleDuration > idleTime && chatDuration > idleTime;

	return isChatIdle;
}
