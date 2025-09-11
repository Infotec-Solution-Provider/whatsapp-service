import { WppChat, WppContact, WppMessage } from "@prisma/client";
import JsonSessionStore from "../utils/json-session-store";
import whatsappService from "../services/whatsapp.service";
import prismaService from "../services/prisma.service";
import socketService from "../services/socket.service";
import instancesService from "../services/instances.service";
import messagesDistributionService from "../services/messages-distribution.service";
import { SocketEventType } from "@in.pulse-crm/sdk";
import ProcessingLogger from "../utils/processing-logger";
import "dotenv/config";

/**
 * ExatronSatisfactionBot
 *
 * Coleta avaliação do cliente em 3 etapas:
 *  - Step 0: aguarda uma nota inicial (1 a 10). Se válida, registra (quando possível) e envia a 1ª pergunta.
 *  - Step 1: faz 4 perguntas (1 a 10 cada). Armazena cada resposta (quando possível) e avança.
 *  - Step 2: finaliza o atendimento e envia mensagem de agradecimento.
 *
 * Integrações:
 *  - Envio de mensagens: whatsappService.sendBotMessage
 *  - Registro no histórico: messagesDistributionService.addSystemMessage
 *  - Finalização do chat: Prisma + socketService (WppChatFinished)
 *  - Persistência opcional em base legada (se existir): instancesService.executeQuery
 *
 * Como usar:
 *  - Instanciar e chamar processMessage(chat, contact, message) a cada mensagem do cliente.
 *  - O bot mantém estado em memória por chatId; reinicia sozinho ao finalizar.
 *  - Para customizar as perguntas, altere o array QUESTIONS.
 */

type RunningSession = {
    chatId: number;
    step: number; // 0 -> espera nota inicial; 1 -> respondendo perguntas; 2 -> finalização
    questionIndex: number;
    lastActivity: number; // timestamp (ms) da última interação
}; const QUESTIONS: readonly string[] = [
    "Os produtos da Exatron atendem às suas expectativas em termos de qualidade, inovação e clareza nas informações de instalação e uso?\n- Avalie com um número de 1 a 10.",
    "Caso tenha utilizado nossa Assistência Técnica, como avalia a experiência em relação ao atendimento, esclarecimento de dúvidas e tempo de resposta?\n- Avalie com um número de 1 a 10.",
    "O atendimento da nossa equipe (funcionários e representantes) atendeu suas necessidades de forma satisfatória?\n- Avalie com um número de 1 a 10.",
    "De forma geral, quão satisfeito está com a Exatron?\n- Avalie com um número de 1 a 10."
];

const INVALID_RATING_MSG = "Resposta inválida, por favor digite uma opção válida (um número de 1 a 10).";
const THANKS_MSG = "Obrigado pela sua avaliação! Se precisar de algo mais, estou à disposição.";
const FINISH_MSG = "Atendimento finalizado, pesquisa respondida.";
const TIMEOUT_MSG = "Atendimento finalizado por inatividade na pesquisa.";

const INACTIVITY_TIMEOUT_MS = process.env["EXATRON_PESQUISA_TIMEOUT_MS"] ? parseInt(process.env["EXATRON_PESQUISA_TIMEOUT_MS"]) : 30 * 60 * 1000;

// Persistência local dos estados do bot
const store = new JsonSessionStore<RunningSession>({ filename: "exatron-satisfaction.sessions.json" });

class ExatronSatisfactionBot {
    // Estado por chat (em memória)
    private sessions = new Map<number, RunningSession>();
    private initialized = false;
    private watcherStarted = false;    /** Garante que o estado foi carregado do disco (lazy). */
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
                        lastActivity: s.lastActivity ?? now
                    });
                }
            }
            this.initialized = true;
        });
        this.startWatcher();
    }    /** Obtém a sessão do chat ou cria uma nova. */
    private getOrCreate(chatId: number): RunningSession {
        let s = this.sessions.get(chatId);
        if (!s) {
            s = { chatId, step: 0, questionIndex: 0, lastActivity: Date.now() };
            this.sessions.set(chatId, s);
            store.scheduleSave(() => this.sessions.values());
        }
        return s;
    }    /** Remove a sessão do chat (terminou o fluxo). */
    private remove(chatId: number) {
        this.sessions.delete(chatId);
        store.scheduleSave(() => this.sessions.values());
    }

    /** Permite resetar o fluxo manualmente (ex.: intervenção humana). */
    public async reset(chatId: number) {
        await this.ensureLoaded();
        this.sessions.set(chatId, { chatId, step: 0, questionIndex: 0, lastActivity: Date.now() });
        store.scheduleSave(() => this.sessions.values());
    }

    private startWatcher() {
        if (this.watcherStarted) return;
        this.watcherStarted = true;
        setInterval(async () => {
            const now = Date.now();
            for (const s of Array.from(this.sessions.values())) {
                if (s.step < 2 && now - s.lastActivity >= INACTIVITY_TIMEOUT_MS) {
                    try {
                        const chat = await prismaService.wppChat.findUnique({ where: { id: s.chatId } });
                        if (!chat || chat.isFinished) {
                            this.remove(s.chatId);
                            continue;
                        }
                        const logger = new ProcessingLogger(chat.instance, "exatron-satisfaction", `timeout-${chat.id}-${now}`, {
                            chatId: chat.id,
                            step: s.step,
                            reason: "inactivity-timeout"
                        });
                        logger.log("Sessão expirada por inatividade. Finalizando.");
                        await this.finishChat(chat, logger);
                        const contact = chat.contactId ? await prismaService.wppContact.findUnique({ where: { id: chat.contactId } }) : null;
                        const from = contact?.phone || "";
                        await this.sendBotText(from, chat, TIMEOUT_MSG);
                        this.remove(s.chatId);
                        logger.success({ finished: true });
                    } catch (e) {
                        // silêncio: próxima iteração tentará novamente se ainda existir
                    }
                }
            }
        }, 60_000); // verifica a cada 1 min
    }    /**
     * Extrai a primeira nota 1-10 encontrada no texto.
     * Aceita variações como "nota 10", "8", etc. Evita capturar números como 101.
     */
    private getRating(text: string): number | null {
        const match = text.match(/(?:^|\D)(10|[1-9])(?:\D|$)/);
        if (!match) return null;
        const n = Number(match[1]);
        if (!Number.isFinite(n) || n < 1 || n > 10) return null;
        return n;
    }

    /** Helper para enviar texto do bot, citando opcionalmente a mensagem do cliente. */
    private async sendBotText(from: string, chat: WppChat, text: string, quotedId?: number) {
        await whatsappService.sendBotMessage(from, { chat, text, quotedId: quotedId ?? null });
    }

    /** Envia a pergunta pelo índice. */
    private async sendQuestion(from: string, chat: WppChat, index: number, quotedId?: number) {
        const q = QUESTIONS[index]!;
        await this.sendBotText(from, chat, q, quotedId);
    }

    // Tenta persistir a nota/resposta no banco da instância (se existir a estrutura antiga). Ignora falhas.
    private async tryStoreInitialRating(
        instance: string,
        chat: WppChat,
        originalMessage: string | undefined,
        rating: number,
        logger?: ProcessingLogger
    ) {
        try {
            logger?.log("Persistindo nota inicial na base legada (se disponível)");
            // Muitas bases antigas possuem w_atendimentos_feedbacks. Usamos chat.id como fallback para CODIGO_ATENDIMENTO.
            await instancesService.executeQuery<any>(
                instance,
                "UPDATE w_atendimentos_feedbacks SET NOTA_ATENDIMENTO = ?, COMENTARIO = ? WHERE CODIGO_ATENDIMENTO = ?",
                [rating, `${originalMessage || ""}`, chat.id]
            );
            logger?.log("Nota inicial persistida com sucesso");
        } catch (e) {
            // silencioso: base pode não ter a tabela/colunas
            logger?.log("Falha ao persistir nota inicial (tabela ausente?)");
        }
    }

    private async tryStoreQuestionAnswer(
        instance: string,
        chat: WppChat,
        contact: WppContact,
        question: string,
        originalMessage: string | undefined,
        rating: number,
        logger?: ProcessingLogger
    ) {
        try {
            // Opcionalmente tentamos descobrir um possível numberId; se falhar, usamos 0.
            let numberId = 0;
            try {
                const phone = (contact.phone || "").replace(/[^0-9]/g, "");
                logger?.log("Buscando numberId no legado por telefone", { phone });
                const res =
                    (await instancesService.executeQuery<Array<{ CODIGO: number }>>(
                        instance,
                        "SELECT CODIGO FROM w_numeros WHERE NUMERO = ? LIMIT 1",
                        [phone]
                    )) || [];
                if (res.length > 0 && res[0]) numberId = res[0].CODIGO;
            } catch { }

            logger?.log("Persistindo resposta de pergunta no legado (se disponível)", { question, rating });
            await instancesService.executeQuery<any>(
                instance,
                "INSERT INTO w_questionarios_respostas (CODIGO_ATENDIMENTO, CODIGO_NUMERO, PERGUNTA, RESPOSTA, NOTA) VALUES (?, ?, ?, ?, ?)",
                [chat.id, numberId, question, originalMessage || "", rating]
            );
            logger?.log("Resposta persistida com sucesso");
        } catch (e) {
            // silencioso: base pode não ter a tabela/colunas
            logger?.log("Falha ao persistir resposta (tabela ausente?)");
        }
    }

    private async finishChat(chat: WppChat, logger?: ProcessingLogger) {
        // Finaliza no padrão do projeto atual (similar ao choose-sector.bot)
        logger?.log("Finalizando chat pelo bot de satisfação");
        const updated = await prismaService.wppChat.update({
            where: { id: chat.id },
            data: {
                isFinished: true,
                finishedAt: new Date(),
                finishedBy: null
            }
        });

        // Usa mensagem de sistema para registrar no histórico do chat atual
        logger?.log("Adicionando mensagem de sistema de finalização");
        await messagesDistributionService.addSystemMessage(updated, FINISH_MSG);

        logger?.log("Emitindo evento de finalização no socket");
        await socketService.emit(
            SocketEventType.WppChatFinished,
            `${updated.instance}:chat:${updated.id}`,
            { chatId: updated.id }
        );
    }

    /**
     * Inicia o fluxo pedindo a nota inicial (Step 0) de forma proativa.
     * Útil quando você quer disparar a pesquisa sem aguardar mensagem do cliente.
     */
    public async startInitialRating(chat: WppChat, contact: WppContact, to: string, quotedId?: number) {
        await this.ensureLoaded();
        const session = this.getOrCreate(chat.id);

        const logger = new ProcessingLogger(
            chat.instance,
            "exatron-satisfaction",
            `start-initial-${chat.id}-${Date.now()}`,
            { chatId: chat.id, contactId: contact.id, mode: "initial-rating" }
        );
        try {
            // Garante Step 0 (aguarda nota) e zera índice de perguntas
            session.step = 0;
            session.questionIndex = 0;
            session.lastActivity = Date.now();
            store.scheduleSave(() => this.sessions.values());

            logger.log("Disparando mensagem para coleta de nota inicial (Step 0)");
            const intro = "Para iniciarmos, por favor, avalie nosso atendimento de 1 a 10.";
            await this.sendBotText(to, chat, intro, quotedId);
            logger.success({ step: session.step });
        } catch (err) {
            logger.failed(err);
        }
    }

    /**
     * Inicia o fluxo diretamente na primeira pergunta (Step 1, questionIndex=0).
     * Use quando quiser pular a nota inicial e começar pelo questionário.
     */
    public async startBot(chat: WppChat, contact: WppContact, to: string, quotedId?: number) {
        await this.ensureLoaded();
        const session = this.getOrCreate(chat.id);

        const logger = new ProcessingLogger(
            chat.instance,
            "exatron-satisfaction",
            `start-firstq-${chat.id}-${Date.now()}`,
            { chatId: chat.id, contactId: contact.id, mode: "first-question" }
        );
        try {
            await messagesDistributionService.addSystemMessage(chat, "Iniciando pesquisa de satisfação.", false);

            await prismaService.wppChat.update(
                {
                    where: { id: chat.id },
                    data: { isFinished: false, botId: 2 }
                }
            );

            session.step = 1;
            session.questionIndex = 0;
            session.lastActivity = Date.now();
            store.scheduleSave(() => this.sessions.values());

            logger.log("Enviando primeira pergunta (Step 1, questionIndex=0)");
            await this.startInitialRating(chat, contact, to, quotedId);
            logger.success({ step: session.step, questionIndex: session.questionIndex });
        } catch (err) {
            logger.failed(err);
        }
    }

    public async processMessage(chat: WppChat, contact: WppContact, message: WppMessage) {
        await this.ensureLoaded();
        const session = this.getOrCreate(chat.id);
        session.lastActivity = Date.now();
        store.scheduleSave(() => this.sessions.values());

        const instance = chat.instance;
        const from = message.from;

        const logger = new ProcessingLogger(
            instance,
            "exatron-satisfaction",
            `chat-${chat.id}-${Date.now()}`,
            { chatId: chat.id, contactId: contact.id, messageId: message.id, step: session.step, questionIndex: session.questionIndex }
        );
        try {
            if (session.step === 0) {
                // Espera a primeira nota (1-10)
                logger.log("Step 0: aguardando nota inicial");
                const rating = this.getRating(message.body);
                if (rating === null) {
                    logger.log("Nota inválida recebida");
                    await this.sendBotText(from, chat, INVALID_RATING_MSG, message.id);
                    return;
                }

                logger.log("Nota válida recebida", { rating });
                await this.tryStoreInitialRating(instance, chat, message.body, rating, logger);

                session.step = 1;
                session.questionIndex = 0;
                session.lastActivity = Date.now();
                store.scheduleSave(() => this.sessions.values());
                logger.log("Enviando primeira pergunta", { index: session.questionIndex });
                await this.sendQuestion(from, chat, session.questionIndex, message.id);
                logger.success({ step: session.step, questionIndex: session.questionIndex });
                return;
            }

            if (session.step === 1) {
                logger.log("Step 1: aguardando resposta da pergunta", { index: session.questionIndex });
                const rating = this.getRating(message.body);
                if (rating === null) {
                    logger.log("Resposta inválida para pergunta", { index: session.questionIndex });
                    await this.sendBotText(from, chat, INVALID_RATING_MSG, message.id);
                    return;
                }

                const question = QUESTIONS[session.questionIndex]!;
                logger.log("Resposta válida recebida para pergunta", { index: session.questionIndex, rating });
                await this.tryStoreQuestionAnswer(instance, chat, contact, question, message.body, rating, logger);

                session.questionIndex++;
                session.lastActivity = Date.now();
                store.scheduleSave(() => this.sessions.values());
                if (session.questionIndex < QUESTIONS.length) {
                    logger.log("Enviando próxima pergunta", { index: session.questionIndex });
                    await this.sendQuestion(from, chat, session.questionIndex, message.id);
                    logger.success({ step: session.step, questionIndex: session.questionIndex });
                    return;
                }

                // Sem mais perguntas -> finaliza
                session.step = 2;
                session.lastActivity = Date.now();
                store.scheduleSave(() => this.sessions.values());
                logger.log("Todas perguntas respondidas, avançando para finalização");
            }

            if (session.step === 2) {
                await this.finishChat(chat, logger);
                await this.sendBotText(from, chat, THANKS_MSG, message.id);
                this.remove(chat.id);
                logger.success({ step: session.step, finished: true });
                return;
            }
        } catch (err) {
            logger.failed(err);
        }
    }
}

export default new ExatronSatisfactionBot();
