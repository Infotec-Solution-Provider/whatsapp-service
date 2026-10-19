import { SocketEventType } from "../sdk-local";
import { WppChat, WppContact, WppMessage } from "@prisma/client";
import "dotenv/config";
import chatsService from "../services/chats.service";
import instancesService from "../services/instances.service";
import messagesService from "../services/messages.service";
import parametersService from "../services/parameters.service";
import prismaService from "../services/prisma.service";
import socketService from "../services/socket.service";
import whatsappService from "../services/whatsapp.service";
import ProcessingLogger from "../utils/processing-logger";
import path from "node:path";
import { SatisfactionSessionStore } from "./satisfaction-session-store";
import { persistInitialSurveyRating, persistSurveyAnswer, SurveyChatLock } from "./satisfaction-answer-persistence";

type RunningSession = {
	chatId: number;
	sectorId?: number; // optional sector ID for fetching client
	userId: number | null;
	step: number; // 0 -> legado (nota inicial); 1 -> respondendo perguntas; 2 -> finalização
	questionIndex: number;
	lastActivity: number; // timestamp (ms) da última interação
	timeoutms?: number; // opcionalmente pode ter timeout customizado
	pendingAnswer?: { messageId: number; rating: number; questionIndex: number; initial: boolean };
	lastProcessedMessageId?: number;
};

type SatisfactionQuestionKey = "q1" | "q2" | "q3" | "q4";

interface SatisfactionQuestion {
	key: SatisfactionQuestionKey;
	text: string;
}

const QUESTIONS: readonly SatisfactionQuestion[] = [
	{
		key: "q1",
		text: "Os produtos da Exatron atendem às suas expectativas em termos de qualidade, inovação e clareza nas informações de instalação e uso?\nDigite de 1 a 10"
	},
	{
		key: "q2",
		text: "Caso tenha utilizado nossa assistência técnica, como avalia a experiência em relação ao atendimento, esclarecimento de dúvidas e tempo de resposta?\nDigite de 1 a 10 ou 99 caso nunca tenha usado a assistência técnica"
	},
	{
		key: "q3",
		text: "O atendimento da nossa equipe (Funcionários e Representantes) atendeu suas necessidades de forma satisfatória?\nDigite de 1 a 10"
	},
	{
		key: "q4",
		text: "De forma geral, quão satisfeito está com a Exatron?\nDigite de 1 a 10"
	}
];

const INITIAL_QUESTION =
	"Como foi sua experiência? Por favor, avalie nosso atendimento de 1 a 10.\n\nPara avaliar, basta responder com a sua nota.";
const INVALID_RATING_MSG = "Resposta inválida, por favor digite uma opção válida (um número de 1 a 10).";
const INVALID_RATING_ASSISTANCE_MSG =
	"Resposta inválida. Para esta pergunta, responda com um número de 1 a 10 ou 99 caso nunca tenha utilizado a Assistência Técnica.";
const THANKS_MSG = "Obrigado pela sua avaliação! Se precisar de algo mais, estou à disposição.";
const FINISH_MSG = "Atendimento finalizado, pesquisa respondida.";
const TIMEOUT_MSG = "Atendimento finalizado por inatividade na pesquisa.";

const INACTIVITY_TIMEOUT_MS = process.env["EXATRON_PESQUISA_TIMEOUT_MS"]
	? parseInt(process.env["EXATRON_PESQUISA_TIMEOUT_MS"])
	: 30 * 60 * 1000;

const store = new SatisfactionSessionStore<RunningSession>(path.resolve(process.cwd(), "data", "exatron-satisfaction.sessions.json"));

class ExatronSatisfactionBot {
	private sessions = new Map<number, RunningSession>();
	private initialized = false;
	private watcherStarted = false;
	private readonly chatLock = new SurveyChatLock();

	private async ensureLoaded() {
		if (this.initialized) return;

		await store.ensureLoaded((arr) => {
			this.sessions.clear();
			const now = Date.now();

			for (const s of arr) {
				if (s && typeof s.chatId === "number") {
					this.sessions.set(s.chatId, {
						chatId: s.chatId,
						step: s.step ?? 0,
						questionIndex: s.questionIndex ?? 0,
						lastActivity: s.lastActivity ?? now,
						userId: s.userId,
						...(s.sectorId ? { sectorId: s.sectorId } : {}),
						...(s.pendingAnswer ? { pendingAnswer: s.pendingAnswer } : {}),
						...(s.lastProcessedMessageId ? { lastProcessedMessageId: s.lastProcessedMessageId } : {}),
						timeoutms: s.timeoutms ?? INACTIVITY_TIMEOUT_MS
					});
				}
			}
			this.initialized = true;
		});

		this.startWatcher();
	}

	private async getOrCreate(chat: WppChat): Promise<RunningSession> {
		let s = this.sessions.get(chat.id);
		const userParams = await parametersService.getSessionParams({
			instance: "exatron",
			sectorId: chat.sectorId!,
			userId: chat.userId!
		});
		const timeoutms = Number(userParams["satisfaction_survey_timeout_ms"] || INACTIVITY_TIMEOUT_MS);

		if (!s) {
			const newSession: RunningSession = {
				chatId: chat.id,
				userId: chat.userId,
				step: 1,
				questionIndex: 0,
				lastActivity: Date.now(),
				timeoutms
			};
			if (chat.sectorId) {
				newSession.sectorId = chat.sectorId;
			}
			s = newSession;
			this.sessions.set(chat.id, s);
			store.scheduleSave(() => this.sessions.values());
		}

		return s;
	}

	private remove(chatId: number) {
		this.sessions.delete(chatId);
		store.scheduleSave(() => this.sessions.values());
	}

	/** Permite resetar o fluxo manualmente (ex.: intervenção humana). */
	public async reset(chatId: number, userId: number) {
		return this.chatLock.run(chatId, () => this.resetLocked(chatId, userId));
	}

	private async resetLocked(chatId: number, userId: number) {
		await this.ensureLoaded();
		if (this.sessions.get(chatId)?.pendingAnswer) throw new Error("SURVEY_ANSWER_PENDING_PERSISTENCE");
		const newSession: RunningSession = {
			chatId,
			step: 1,
			questionIndex: 0,
			lastActivity: Date.now(),
			userId
		};
		this.sessions.set(chatId, newSession);
		store.scheduleSave(() => this.sessions.values());
	}

	private startWatcher() {
		if (this.watcherStarted) return;
		this.watcherStarted = true;

		setInterval(async () => {
			try {
				await this.checkSessionTimeouts();
			} catch (err) {
				console.error("Error in timeout watcher:", err);
			}
		}, 60_000); // verifica a cada 1 min
	}

	private async checkSessionTimeouts(): Promise<void> {
		const now = Date.now();

		for (const s of Array.from(this.sessions.values())) {
			await this.chatLock.run(s.chatId, async () => {
				if (this.sessions.get(s.chatId) !== s) return;
				// A storage failure is not customer inactivity. Preserve and retry the original answer.
				if (s.pendingAnswer) { await this.retryPendingAnswer(s); return; }
				const timeoutms = s.timeoutms ?? INACTIVITY_TIMEOUT_MS;
				if (s.step < 2 && now - s.lastActivity >= timeoutms) await this.handleSessionTimeout(s, now);
			});
		}
	}

	private async retryPendingAnswer(session: RunningSession): Promise<void> {
		const pending = session.pendingAnswer;
		if (!pending) return;
		const logger = new ProcessingLogger("exatron", "exatron-satisfaction-persistence", `retry-${session.chatId}-${pending.messageId}-${Date.now()}`, {
			chatId: session.chatId, messageId: pending.messageId, questionIndex: pending.questionIndex,
		});
		try {
			const chat = await prismaService.wppChat.findUnique({ where: { id: session.chatId } });
			const message = await prismaService.wppMessage.findUnique({ where: { id: pending.messageId } });
			const contact = chat?.contactId ? await prismaService.wppContact.findUnique({ where: { id: chat.contactId } }) : null;
			if (!chat || chat.instance !== "exatron" || !contact || contact.instance !== chat.instance || !message || message.instance !== chat.instance || message.chatId !== chat.id) {
				throw new Error("SURVEY_PENDING_SOURCE_UNAVAILABLE");
			}
			await this.persistPendingAnswer(chat, contact, session, message, logger);
		} catch {
			logger.failed(new Error("SURVEY_ANSWER_PENDING_PERSISTENCE"));
		}
	}

	private async handleSessionTimeout(session: RunningSession, now: number): Promise<void> {
		try {
			const chat = await prismaService.wppChat.findUnique({ where: { id: session.chatId } });
			if (!chat || chat.isFinished) {
				this.remove(session.chatId);
				return;
			}

			const logger = new ProcessingLogger(chat.instance, "exatron-satisfaction", `timeout-${chat.id}-${now}`, {
				chatId: chat.id,
				step: session.step,
				reason: "inactivity-timeout"
			});
			logger.log("Sessão expirada por inatividade. Finalizando.");

			await this.finishChat(chat, logger);

			const contact = chat.contactId
				? await prismaService.wppContact.findUnique({ where: { id: chat.contactId } })
				: null;
			const from = contact?.phone || "";

			await this.sendBotText(from, chat, TIMEOUT_MSG);
			this.remove(session.chatId);
			logger.success({ finished: true });
		} catch (err) {
			// Silently continue - will retry on next interval if session still exists
		}
	}

	private getRating(text: string): number | null {
		const match = text.match(/(?:^|\D)(10|[1-9])(?:\D|$)/);
		if (!match) return null;
		const n = Number(match[1]);
		if (!Number.isFinite(n) || n < 1 || n > 10) return null;
		return n;
	}

	private getQuestionAnswer(text: string, questionIndex: number): number | null {
		// Pergunta 2 (índice 1): aceita 1..10 ou 99 (não utilizou assistência)
		if (questionIndex === 1) {
			const match99 = text.match(/(?:^|\D)(99)(?:\D|$)/);
			if (match99) return 99;
		}

		return this.getRating(text);
	}

	private getMessageTarget(contact: WppContact, message: WppMessage): string {
		const contactPhone = (contact.phone || "").trim();
		if (contactPhone) return contactPhone;
		return message.from;
	}

	/** Helper para enviar texto do bot, citando opcionalmente a mensagem do cliente. */
	private async sendBotText(from: string, chat: WppChat, text: string, quotedId?: number) {
		const sector = await prismaService.wppSector.findUnique({ where: { id: chat.sectorId || 0 } });

		if (!sector || !sector.defaultClientId) {
			return;
		}
		const client = whatsappService.getClient(sector.defaultClientId);

		if (!client) {
			return;
		}
		await whatsappService.sendBotMessage(from, client.id, { chat, text, quotedId: quotedId ?? null });
	}

	/** Envia a pergunta pelo índice. */
	private async sendQuestion(from: string, chat: WppChat, index: number, quotedId?: number) {
		const question = QUESTIONS[index]!;
		await this.sendBotText(from, chat, question.text, quotedId);
	}

	private async addSystemMessageForChat(
		chat: WppChat,
		text: string,
		notify: boolean,
	) {
		const now = new Date();
		const message: WppMessage = await messagesService.insertMessage({
			body: text,
			from: "system",
			to: "system",
			instance: chat.instance,
			status: "RECEIVED",
			timestamp: now.getTime().toString(),
			sentAt: now,
			type: "chat",
			chatId: chat.id,
			contactId: chat.contactId,
			clientId: null
		});

		if (notify) {
			const chatRoom = `${chat.instance}:chat:${chat.id}` as const;
			await socketService.emit(SocketEventType.WppMessage, chatRoom, { message });
		}
	}

	private async queueAnswer(chat: WppChat, contact: WppContact, session: RunningSession, message: WppMessage,
		rating: number, initial: boolean, logger: ProcessingLogger): Promise<void> {
		session.pendingAnswer = { messageId: message.id, rating, questionIndex: session.questionIndex, initial };
		// Save only the reference. The original answer remains in the existing messages table.
		await store.save(() => this.sessions.values());
		await this.persistPendingAnswer(chat, contact, session, message, logger);
	}

	private async persistPendingAnswer(chat: WppChat, contact: WppContact, session: RunningSession,
		message: WppMessage, logger: ProcessingLogger): Promise<void> {
		const pending = session.pendingAnswer;
		if (!pending || pending.messageId !== message.id) throw new Error("SURVEY_PENDING_ANSWER_MISMATCH");
		const query = (sql: string, values: unknown[]) => instancesService.executeQuery<unknown>(chat.instance, sql, values);
		if (pending.initial) {
			await persistInitialSurveyRating(query, chat.id, message.body, pending.rating);
		} else {
			const question = QUESTIONS[pending.questionIndex];
			if (!question) throw new Error("SURVEY_PENDING_QUESTION_INVALID");
			const numbers = await instancesService.executeQuery<Array<{ CODIGO: number }>>(
				chat.instance, "SELECT CODIGO FROM w_numeros WHERE NUMERO = ? LIMIT 1", [(contact.phone || "").replace(/[^0-9]/g, "")],
			);
			await persistSurveyAnswer(query, {
				chatId: chat.id, numberId: numbers[0]?.CODIGO ?? 0, messageId: message.id,
				questionKey: question.key, question: question.text, questionIndex: pending.questionIndex,
				answer: message.body, rating: pending.rating,
			});
		}
		logger.log("Persistência da resposta confirmada", { messageId: message.id, questionIndex: pending.questionIndex });
		const previous = { ...session };
		session.questionIndex = pending.initial ? 0 : pending.questionIndex + 1;
		session.step = session.questionIndex >= QUESTIONS.length ? 2 : 1;
		session.lastActivity = Date.now();
		session.lastProcessedMessageId = message.id;
		delete session.pendingAnswer;
		try { await store.save(() => this.sessions.values()); }
		catch {
			Object.assign(session, previous);
			if (previous.lastProcessedMessageId === undefined) delete session.lastProcessedMessageId;
			throw new Error("SURVEY_PROGRESS_SAVE_FAILED");
		}
		// A supervisor may have closed the chat during a CRM outage. Save the answer without reopening/sending.
		const current = await prismaService.wppChat.findFirst({ where: { id: chat.id, instance: chat.instance } });
		if (!current || current.isFinished) { this.remove(chat.id); return; }
		const target = this.getMessageTarget(contact, message);
		if (session.step === 2) {
			await this.finishChat(chat, logger);
			await this.sendBotText(target, chat, THANKS_MSG, message.id);
			this.remove(chat.id);
		} else {
			await this.sendQuestion(target, chat, session.questionIndex, message.id);
		}
		logger.success({ step: session.step, questionIndex: session.questionIndex });
	}

	private async finishChat(chat: WppChat, logger?: ProcessingLogger) {
		// Finaliza no padrão do projeto atual (similar ao choose-sector.bot)
		logger?.log("Finalizando chat pelo bot de satisfação");
		const finishedBy =
			typeof chat.userId === "number"
				? chat.userId
				: typeof chat.finishedBy === "number"
					? chat.finishedBy
					: null;
		const updated = await prismaService.wppChat.update({
			where: { id: chat.id },
			data: {
				isFinished: true,
				finishedAt: new Date(),
				finishedBy
			}
		});
		await chatsService.syncChatToLocal(updated);

		// Usa mensagem de sistema para registrar no histórico do chat atual
		logger?.log("Adicionando mensagem de sistema de finalização");
		await this.addSystemMessageForChat(updated, FINISH_MSG, true);

		logger?.log("Emitindo evento de finalização no socket");
		await socketService.emit(SocketEventType.WppChatFinished, `${updated.instance}:chat:${updated.id}`, {
			chatId: updated.id
		});
	}

	/**
	 * Inicia o fluxo pedindo a nota inicial (Step 0) de forma proativa.
	 * Útil quando você quer disparar a pesquisa sem aguardar mensagem do cliente.
	 */
	public async startInitialRating(chat: WppChat, contact: WppContact, to: string, quotedId?: number) {
		return this.chatLock.run(chat.id, () => this.startInitialRatingLocked(chat, contact, to, quotedId));
	}

	private async startInitialRatingLocked(chat: WppChat, contact: WppContact, to: string, quotedId?: number) {
		if (chat.instance !== "exatron") {
			return;
		}

		await this.ensureLoaded();
		const session = await this.getOrCreate(chat);

		const logger = new ProcessingLogger(
			chat.instance,
			"exatron-satisfaction",
			`start-initial-${chat.id}-${Date.now()}`,
			{ chatId: chat.id, contactId: contact.id, mode: "initial-rating" }
		);
		try {
			if (session.pendingAnswer) throw new Error("SURVEY_ANSWER_PENDING_PERSISTENCE");
			// Garante Step 0 (aguarda nota) e zera índice de perguntas
			session.step = 0;
			session.questionIndex = 0;
			session.lastActivity = Date.now();
			store.scheduleSave(() => this.sessions.values());

			logger.log("Disparando mensagem para coleta de nota inicial (Step 0)");
			await this.sendBotText(to, chat, INITIAL_QUESTION, quotedId);
			logger.success({ step: session.step });
		} catch (err) {
			logger.failed(err);
		}
	}

	/**
	 * Inicia o fluxo diretamente na primeira pergunta (Step 1, questionIndex=0).
	 * Use quando quiser pular a nota inicial e começar pelo questionário.
	 */
	public async startBot(
		chat: WppChat,
		contact: WppContact,
		to: string,
		quotedId?: number
	) {
		return this.chatLock.run(chat.id, () => this.startBotLocked(chat, contact, to, quotedId));
	}

	private async startBotLocked(chat: WppChat, contact: WppContact, to: string, quotedId?: number) {
		if (chat.instance !== "exatron") {
			return;
		}

		await this.ensureLoaded();
		const session = await this.getOrCreate(chat);

		const logger = new ProcessingLogger(
			chat.instance,
			"exatron-satisfaction",
			`start-firstq-${chat.id}-${Date.now()}`,
			{ chatId: chat.id, contactId: contact.id, mode: "first-question" }
		);
		try {
			if (session.pendingAnswer) throw new Error("SURVEY_ANSWER_PENDING_PERSISTENCE");
			logger.log("Iniciando startBot", {
				to,
				quotedId: quotedId ?? null,
				sectorId: chat.sectorId ?? null,
				contactPhone: contact.phone || null
			});
			await this.addSystemMessageForChat(chat, "Iniciando pesquisa de satisfação.", false);

			const updated = await prismaService.wppChat.update({
				where: { id: chat.id },
				data: { isFinished: false, botId: 2 }
			});
			await chatsService.syncChatToLocal(updated);

			session.step = 1;
			session.questionIndex = 0;
			session.lastActivity = Date.now();
			store.scheduleSave(() => this.sessions.values());

			logger.log("Enviando primeira pergunta (Step 1, questionIndex=0)", { target: to });
			await this.sendQuestion(to, chat, session.questionIndex, quotedId);
			logger.success({ step: session.step, questionIndex: session.questionIndex });
		} catch (err) {
			logger.failed(err);
		}
	}

	public async processMessage(
		chat: WppChat,
		contact: WppContact,
		message: WppMessage
	) {
		return this.chatLock.run(chat.id, () => this.processMessageLocked(chat, contact, message));
	}

	private async processMessageLocked(
		chat: WppChat,
		contact: WppContact,
		message: WppMessage
	) {
		if (chat.instance !== "exatron") {
			return;
		}

		await this.ensureLoaded();
		const session = await this.getOrCreate(chat);
		if (session.lastProcessedMessageId && message.id <= session.lastProcessedMessageId) return;
		if (session.pendingAnswer) {
			await this.retryPendingAnswer(session);
			return;
		}
		session.lastActivity = Date.now();
		store.scheduleSave(() => this.sessions.values());

		const instance = chat.instance;

		const logger = new ProcessingLogger(instance, "exatron-satisfaction", `chat-${chat.id}-${Date.now()}`, {
			chatId: chat.id,
			contactId: contact.id,
			messageId: message.id,
			step: session.step,
			questionIndex: session.questionIndex
		});
		logger.log("Mensagem recebida", {
			messageId: message.id,
			chatFinished: chat.isFinished
		});

		try {
			switch (session.step) {
				case 0:
					await this.handleInitialRating(chat, contact, session, message, logger);
					break;
				case 1:
					await this.handleQuestionAnswer(chat, contact, session, message, logger);
					break;
				case 2:
					await this.handleCompletion(chat, session, message, logger);
					break;
				default:
					logger.log(`Unknown step: ${session.step}`);
			}
		} catch {
			logger.failed(new Error(session.pendingAnswer ? "SURVEY_ANSWER_PENDING_PERSISTENCE" : "SURVEY_PROCESSING_FAILED"));
		}
	}

	private async handleInitialRating(
		chat: WppChat,
		contact: WppContact,
		session: RunningSession,
		message: WppMessage,
		logger: ProcessingLogger
	): Promise<void> {
		logger.log("Step 0: aguardando nota inicial");
		const rating = this.getRating(message.body);

		if (rating === null) {
			logger.log("Nota inválida recebida");
			const target = this.getMessageTarget(contact, message);
			logger.log("Enviando mensagem de validação", { target });
			await this.sendBotText(target, chat, INVALID_RATING_MSG, message.id);
			return;
		}

		await this.queueAnswer(chat, contact, session, message, rating, true, logger);
	}

	private async handleQuestionAnswer(
		chat: WppChat,
		contact: WppContact,
		session: RunningSession,
		message: WppMessage,
		logger: ProcessingLogger
	): Promise<void> {
		logger.log("Step 1: aguardando resposta da pergunta", { index: session.questionIndex });
		const rating = this.getQuestionAnswer(message.body, session.questionIndex);

		if (rating === null) {
			logger.log("Resposta inválida para pergunta", { index: session.questionIndex });
			const invalidMsg = session.questionIndex === 1 ? INVALID_RATING_ASSISTANCE_MSG : INVALID_RATING_MSG;
			const target = this.getMessageTarget(contact, message);
			logger.log("Enviando mensagem de validação", { target, index: session.questionIndex });
			await this.sendBotText(target, chat, invalidMsg, message.id);
			return;
		}

		await this.queueAnswer(chat, contact, session, message, rating, false, logger);
	}

	private async handleCompletion(
		chat: WppChat,
		session: RunningSession,
		message: WppMessage,
		logger: ProcessingLogger
	): Promise<void> {
		await this.finishChat(chat, logger);
		await this.sendBotText(message.from, chat, THANKS_MSG, message.id);
		this.remove(chat.id);
		logger.success({ step: session.step, finished: true });
	}
}

export default new ExatronSatisfactionBot();
