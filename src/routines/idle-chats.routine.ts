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
const MIN_MESSAGES_WINDOW = 24 * 60 * 60 * 1000;
// Finalizações por execução: um backlog drena em poucos minutos, sem rajada de notificações.
const MAX_ACTIONS_PER_RUN = 50;
// Falhas seguidas indicam tenant indisponível; a próxima execução tenta de novo.
const MAX_CONSECUTIVE_FAILURES = 3;
// Um chat que falhou espera antes de nova tentativa, para não travar os demais.
const FAILED_CHAT_RETRY_DELAY = 15 * 60 * 1000;

const failedChatsRetryAt = new Map<number, number>();

export default async function runIdleChatsJob() {
	const process = new ProcessingLogger("SYSTEM", "idle-chats-routine", "idle-chats", {});

	try {
		process.log("Iniciando rotina de chats inativos");

		const parameters = await getRoutineParameters();
		process.log("Parâmetros da rotina carregados", { total: parameters.length });

		const enabledInstances = await getRoutineEnabledInstances(parameters);
		process.log("Instâncias habilitadas carregadas", { instances: enabledInstances });

		const messagesWindow = getMessagesWindow(parameters);
		const ongoingChats = await getOngoingChats(enabledInstances, messagesWindow);
		process.log("Chats em andamento carregados", { total: ongoingChats.length, messagesWindow });

		const now = Date.now();
		for (const [chatId, retryAt] of failedChatsRetryAt) {
			if (retryAt <= now) failedChatsRetryAt.delete(chatId);
		}

		let processedChats = 0;
		let finishedChats = 0;
		let actions = 0;
		let consecutiveFailures = 0;
		let stopReason: string | null = null;
		const failedChatIds: number[] = [];

		for (const chat of ongoingChats) {
			if (actions >= MAX_ACTIONS_PER_RUN) {
				stopReason = `limite de ${MAX_ACTIONS_PER_RUN} ações por execução`;
				break;
			}
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				stopReason = `${consecutiveFailures} falhas consecutivas`;
				break;
			}
			if (failedChatsRetryAt.has(chat.id)) {
				continue;
			}

			try {
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
					actions++;
					consecutiveFailures = 0;
					process.log(`Chat ${chat.id} - Finalizado: contato excluído`);
					continue;
				}

				if (!hasUserMsg) {
					await finishChatAndNotify(chat, "inatividade do usuário.", chat.contact?.name);
					finishedChats++;
					actions++;
					consecutiveFailures = 0;
					process.log(`Chat ${chat.id} - Finalizado: inatividade do usuário`);
					continue;
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
					actions++;
					consecutiveFailures = 0;
					continue;
				}

				const timeSinceQuestion = Date.now() - (chat.messages[0]?.sentAt.getTime() || 0);
				if (timeSinceQuestion > 15 * 60 * 1000) {
					await finishChatAndNotify(chat, "Inatividade após a pergunta do bot.", chat.contact?.name);
					finishedChats++;
					actions++;
					consecutiveFailures = 0;
					process.log(`Chat ${chat.id} - Finalizado: inatividade após pergunta`);
					continue;
				}
			} catch (error) {
				consecutiveFailures++;
				failedChatIds.push(chat.id);
				failedChatsRetryAt.set(chat.id, Date.now() + FAILED_CHAT_RETRY_DELAY);
				process.log(`Chat ${chat.id} - Falha: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const result = { processedChats, finishedChats, failedChatIds, stopReason };
		process.log("Rotina concluída", result);
		process.success(result);
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

// Sem mensagens na janela o chat conta como ocioso, então ela precisa cobrir o maior tempo configurado.
function getMessagesWindow(parameters: Parameter[]) {
	const idleTimes = parameters
		.filter((param) => param.key === "chat_auto_finish_idle_time")
		.map((param) => Number(param.value))
		.filter((idleTime) => Number.isFinite(idleTime) && idleTime > 0);

	return Math.max(MIN_MESSAGES_WINDOW, DEFAULT_CHAT_IDLE_TIME, ...idleTimes);
}

async function getOngoingChats(instances: string[], messagesWindow: number) {
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
						gte: new Date(Date.now() - messagesWindow)
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

	try {
		await chatsService.systemFinishChatById(chat.id, reason);
	} catch (error) {
		// A falha pode vir depois de o chat ser marcado (ex.: sincronização com o tenant): ainda assim notifica.
		const current = await prismaService.wppChat.findUnique({ where: { id: chat.id }, select: { isFinished: true } });
		if (!current?.isFinished) throw error;
	}

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
}

function checkIsIdle(startedAt: Date, messages: MessageLike[], idleTime: number) {
	const now = Date.now();
	const lastMessageTime = messages[0]?.sentAt.getTime() || 0;

	const idleDuration = now - lastMessageTime;
	const chatDuration = now - startedAt.getTime();
	const isChatIdle = idleDuration > idleTime && chatDuration > idleTime;

	return isChatIdle;
}
