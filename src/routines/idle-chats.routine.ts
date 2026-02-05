import { Parameter, WppChat } from "@prisma/client";
import prismaService from "../services/prisma.service";
import chooseSectorBot from "../bots/choose-sector.bot";
import { Logger } from "@in.pulse-crm/utils";
import chatsService from "../services/chats.service";
import whatsappService from "../services/whatsapp.service";
import ProcessingLogger from "../utils/processing-logger";

interface MessageLike {
	sentAt: Date;
	from: string;
}

const ROUTINE_PARAMETERS = [
	"chat_auto_finish_enabled", // Habilita a rotina se estiver como true
	"chat_auto_finish_idle_time" // Define o tempo em minutos para considerar um chat como ocioso
];

const DEFAULT_CHAT_IDLE_TIME = 30 * 60 * 1000; // minutos

export default async function runIdleChatsJob() {
	const process = new ProcessingLogger("SYSTEM", "idle-chats-routine", "idle-chats", {});
	
	try {
		process.log("Iniciando rotina de chats inativos");
		
		const parameters = await getRoutineParameters();
		process.log("Parâmetros da rotina carregados", { total: parameters.length });
		
		const enabledInstances = await getRoutineEnabledInstances(parameters);
		process.log("Instâncias habilitadas carregadas", { instances: enabledInstances });
		
		const ongoingChats = await getOngoingChats(enabledInstances);
		process.log("Chats em andamento carregados", { total: ongoingChats.length });

		let processedChats = 0;
		let finishedChats = 0;

		for (const chat of ongoingChats) {
			const chatParameters = await getRoutineParametersForChat(parameters, chat);

			if (chatParameters["chat_auto_finish_enabled"] !== "true") {
				process.log(`Chat ${chat.id} - Auto-finish desabilitado`);
				continue;
			}

			const idleTime = Number(chatParameters["chat_auto_finish_idle_time"] || DEFAULT_CHAT_IDLE_TIME);

			if (!chat.startedAt) {
				process.log(`Chat ${chat.id} - Sem data de início`);
				continue;
			}

			const isIdle = checkIsIdle(chat.startedAt, chat.messages, idleTime);
			if (!isIdle) {
				process.log(`Chat ${chat.id} - Não inativo (idleTime: ${idleTime}ms)`);
				continue;
			}

			processedChats++;
			process.log(`Chat ${chat.id} - Detectado como inativo`);

			const hasUserMsg = await checkHasUserMessage(chat.messages);

			if (!chat.contact) {
				await finishChatAndNotify(chat, "contato excluído.");
				finishedChats++;
				process.log(`Chat ${chat.id} - Finalizado: contato excluído`);
				return;
			}

			if (!hasUserMsg) {
				await finishChatAndNotify(chat, "inatividade do usuário.", chat.contact?.name);
				finishedChats++;
				process.log(`Chat ${chat.id} - Finalizado: inatividade do usuário`);
				return;
			}

			const alreadySentQuestion = chooseSectorBot.checkIfAlreadyAskedToBackToMenu(chat);

			if (!alreadySentQuestion) {
				const sector = await prismaService.wppSector.findUnique({ where: { id: chat.sectorId! } });

				if (!sector || !sector.defaultClientId) {
					process.log(`Chat ${chat.id} - Setor não encontrado ou sem client padrão`);
					continue;
				}
				const client = await whatsappService.getClient(sector.defaultClientId);

				if (!client) {
					process.log(`Chat ${chat.id} - Client não encontrado`);
					continue;
				}
				
				process.log(`Chat ${chat.id} - Pergunta de volta ao menu enviada`);
				await chooseSectorBot.askIfWantsToBackToMenu(client.id, chat, chat.contact);
				return;
			}

			const timeSinceQuestion = Date.now() - (chat.messages[0]?.sentAt.getTime() || 0);
			if (timeSinceQuestion > 15 * 60 * 1000) {
				await finishChatAndNotify(chat, "Inatividade após a pergunta do bot.", chat.contact?.name);
				finishedChats++;
				process.log(`Chat ${chat.id} - Finalizado: inatividade após pergunta`);
				return;
			}
		}

		process.log("Rotina concluída", { processedChats, finishedChats });
		process.success({ processedChats, finishedChats });
	} catch (error) {
		process.log(`Erro na rotina: ${error}`);
		process.failed(error);
		throw error;
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
