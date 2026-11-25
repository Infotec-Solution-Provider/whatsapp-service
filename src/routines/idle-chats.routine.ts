import { Parameter, WppChat } from "@prisma/client";
import prismaService from "../services/prisma.service";
import chooseSectorBot from "../bots/choose-sector.bot";
import { Logger } from "@in.pulse-crm/utils";
import chatsService from "../services/chats.service";
import whatsappService from "../services/whatsapp.service";
import ProcessingLogger from "../utils/processing-logger";
import { InstanceQueryUnavailableError } from "../sdk-local/instance.client";
import { listForInstances } from "../services/chat-closure-dates.service";
import { ChatClosureCalendar, closedDateKey, isChatClosureCalendarEnabled } from "../utils/chat-closure-calendar";

interface MessageLike {
	sentAt: Date;
	from: string;
}

const ROUTINE_PARAMETERS = [
	"chat_auto_finish_enabled", // Habilita a rotina se estiver como true
	"chat_auto_finish_idle_time" // Tempo em milissegundos; a tela administrativa exibe minutos
];

const DEFAULT_CHAT_IDLE_TIME = 30 * 60 * 1000; // minutos
const MIN_MESSAGES_WINDOW = 24 * 60 * 60 * 1000;
const BOT_QUESTION_WAIT = 15 * 60 * 1000;
// Finalizações por execução: um backlog drena em poucos minutos, sem rajada de notificações.
const MAX_ACTIONS_PER_RUN = 50;
// Limita as demais falhas consecutivas na mesma execução.
const MAX_CONSECUTIVE_FAILURES = 3;
// Um chat que falhou espera antes de nova tentativa, para não travar os demais.
const FAILED_CHAT_RETRY_DELAY = 15 * 60 * 1000;
const CRM_RETRY_DELAY = 5 * 60 * 1000;

const failedChatsRetryAt = new Map<number, number>();
const crmRetryAt = new Map<string, number>();

export default async function runIdleChatsJob() {
	const process = new ProcessingLogger("SYSTEM", "idle-chats-routine", "idle-chats", {});

	try {
		process.log("Iniciando rotina de chats inativos");

		const parameters = await getRoutineParameters();
		process.log("Parâmetros da rotina carregados", { total: parameters.length });

		const enabledInstances = await getRoutineEnabledInstances(parameters);
		process.log("Instâncias habilitadas carregadas", { instances: enabledInstances });

		const messagesWindow = getMessagesWindow(parameters);

		const now = Date.now();
		for (const [chatId, retryAt] of failedChatsRetryAt) {
			if (retryAt <= now) failedChatsRetryAt.delete(chatId);
		}
		for (const [instance, retryAt] of crmRetryAt) {
			if (retryAt <= now) crmRetryAt.delete(instance);
		}
		const availableInstances = enabledInstances.filter((instance) => !crmRetryAt.has(instance));
		const calendars = await loadCalendars(availableInstances, now).catch((error: unknown) => {
			process.log("Finalização automática em pausa por falha na leitura do calendário");
			process.failed(error);
			return null;
		});
		if (!calendars) return;

		const cutoff = (instance: string, duration: number) => calendars.get(instance)?.cutoff(duration) ?? now - duration;
		const closedInstances = availableInstances.filter((instance) => calendars.get(instance)?.isClosedAt(now));
		const openInstances = availableInstances.filter((instance) => !closedInstances.includes(instance));
		if (closedInstances.length) process.log("Finalização automática em pausa pelo calendário", { instances: closedInstances });
		const messagesSince = new Date(
			Math.min(now - messagesWindow, ...openInstances.map((instance) => cutoff(instance, messagesWindow)))
		);
		const ongoingChats = openInstances.length ? await getOngoingChats(openInstances, messagesSince) : [];
		process.log("Chats em andamento carregados", { total: ongoingChats.length, messagesSince });

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
			if (crmRetryAt.has(chat.instance) || failedChatsRetryAt.has(chat.id)) {
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

				const calendar = calendars.get(chat.instance);
				const lastMessageTime = chat.messages[0]?.sentAt.getTime() ?? 0;
				const idleCutoff = cutoff(chat.instance, idleTime);
				const isIdle = lastMessageTime < idleCutoff && chat.startedAt.getTime() < idleCutoff;
				if (!isIdle) {
					process.log(`Chat ${chat.id} - Não inativo (idleTime: ${idleTime}ms)`);
					continue;
				}

				processedChats++;
				process.log(`Chat ${chat.id} - Detectado como inativo`);

				const hasUserMsg = await checkHasUserMessage(chat.messages);
				if (calendar?.isClosedAt(Date.now())) continue;

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
					if (calendar?.isClosedAt(Date.now())) continue;

					process.log(`Chat ${chat.id} - Pergunta de volta ao menu enviada`);
					await chooseSectorBot.askIfWantsToBackToMenu(client.id, chat, chat.contact);
					actions++;
					consecutiveFailures = 0;
					continue;
				}

				if (lastMessageTime < cutoff(chat.instance, BOT_QUESTION_WAIT)) {
					await finishChatAndNotify(chat, "Inatividade após a pergunta do bot.", chat.contact?.name);
					finishedChats++;
					actions++;
					consecutiveFailures = 0;
					process.log(`Chat ${chat.id} - Finalizado: inatividade após pergunta`);
					continue;
				}
			} catch (error) {
				failedChatIds.push(chat.id);
				failedChatsRetryAt.set(chat.id, Date.now() + FAILED_CHAT_RETRY_DELAY);
				process.log(`Chat ${chat.id} - Falha: ${error instanceof Error ? error.message : String(error)}`);
				if (!pauseForCrmFailure(chat.instance, error)) consecutiveFailures++;
			}
		}

		const pausedInstances = enabledInstances.filter((instance) => crmRetryAt.has(instance));
		if (pausedInstances.length) process.log("Finalização automática em pausa por indisponibilidade do CRM", { instances: pausedInstances });
		const result = { processedChats, finishedChats, failedChatIds, stopReason };
		process.log("Rotina concluída", result);
		process.success(result);
	} catch (error) {
		process.log(`Erro na rotina: ${error}`);
		process.failed(error);
		throw error;
	}
}

async function loadCalendars(instances: string[], now: number) {
	const calendars = new Map<string, ChatClosureCalendar>();
	if (!isChatClosureCalendarEnabled() || !instances.length) return calendars;

	const dates = new Map(instances.map((instance) => [instance, new Set<string>()]));
	// Include tomorrow so a run that crosses midnight can still check for a closure.
	const through = closedDateKey(now + MIN_MESSAGES_WINDOW);
	for (const { instance, date } of await listForInstances(instances, through)) dates.get(instance)?.add(date);
	for (const [instance, closedDates] of dates) calendars.set(instance, new ChatClosureCalendar(closedDates, now));
	return calendars;
}

function pauseForCrmFailure(instance: string, error: unknown): boolean {
	if (!(error instanceof InstanceQueryUnavailableError) || error.instance !== instance) return false;
	crmRetryAt.set(instance, Date.now() + CRM_RETRY_DELAY);
	return true;
}

async function getRoutineEnabledInstances(parameters: Parameter[]) {
	// A sector/user exception can enable the routine even when the instance is disabled.
	const enabled = parameters.filter((param) => param.key === "chat_auto_finish_enabled" && param.value === "true");
	const instances = enabled.flatMap((param) => (param.instance ? [param.instance] : []));
	const legacySectorIds = enabled
		.filter((param) => param.scope === "SECTOR" && !param.instance && param.sectorId !== null)
		.map((param) => param.sectorId!);
	if (legacySectorIds.length) {
		const sectors = await prismaService.wppSector.findMany({
			where: { id: { in: legacySectorIds } },
			select: { instance: true }
		});
		instances.push(...sectors.map((sector) => sector.instance));
	}
	return [...new Set(instances)];
}

// Sem mensagens na janela o chat conta como ocioso, então ela precisa cobrir o maior tempo configurado.
function getMessagesWindow(parameters: Parameter[]) {
	const idleTimes = parameters
		.filter((param) => param.key === "chat_auto_finish_idle_time")
		.map((param) => Number(param.value))
		.filter((idleTime) => Number.isFinite(idleTime) && idleTime > 0);

	return Math.max(MIN_MESSAGES_WINDOW, DEFAULT_CHAT_IDLE_TIME, ...idleTimes);
}

async function getOngoingChats(instances: string[], messagesSince: Date) {
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
						gte: messagesSince
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
		},
		orderBy: { id: "asc" }
	});
}

async function getRoutineParametersForChat(parameters: Parameter[], chat: WppChat) {
	const chatParameters: { [key: string]: string | null } = {};

	const instanceParams = parameters.filter((param) => param.scope === "INSTANCE" && param.instance === chat.instance);
	const sectorParams = parameters.filter(
		(param) =>
			param.scope === "SECTOR" &&
			chat.sectorId !== null &&
			param.sectorId === chat.sectorId &&
			(param.instance === null || param.instance === chat.instance)
	);
	const userParams = parameters.filter(
		(param) =>
			param.scope === "USER" &&
			chat.userId !== null &&
			param.instance === chat.instance &&
			param.userId === chat.userId
	);

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
		const current = await prismaService.wppChat.findUnique({
			where: { id: chat.id },
			select: { isFinished: true }
		});
		if (!current?.isFinished) throw error;
		pauseForCrmFailure(chat.instance, error);
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
