import { WppChat, WppContact, WppMessage } from "@prisma/client";
import "dotenv/config";
import instancesService from "../services/instances.service";
import messagesDistributionService from "../services/messages-distribution.service";
import prismaService from "../services/prisma.service";
import whatsappService from "../services/whatsapp.service";
import JsonSessionStore from "../utils/json-session-store";
import ProcessingLogger from "../utils/processing-logger";
import parametersService from "../services/parameters.service";
import chatsService from "../services/chats.service";

type RunningSession = {
	chatId: number;
	contactId: number;
	step: number; // 0 -> solicitar CNPJ; 1 -> aguardando confirmação; 2 -> finalizado
	lastActivity: number; // timestamp (ms) da última interação
	cnpj?: string;
	foundCustomerId?: number;
	timeoutms?: number;
};

const ASK_CNPJ_MSG = "Para prosseguir, preciso vincular seu cadastro. Por favor, informe o CNPJ da sua empresa.";
const INVALID_CNPJ_MSG =
	"CNPJ inválido. Por favor, digite um CNPJ válido (apenas números ou com formatação XX.XXX.XXX/XXXX-XX).";
const CUSTOMER_FOUND_MSG = "Cliente encontrado! Vinculando seu cadastro...";
const CUSTOMER_LINKED_MSG = "Cadastro vinculado com sucesso! Você já pode prosseguir com o atendimento.";
const CUSTOMER_NOT_FOUND_MSG =
	"Cliente não encontrado em nossa base de dados. Você será direcionado para atendimento humano.";
const TIMEOUT_MSG = "Atendimento finalizado por inatividade.";

const INACTIVITY_TIMEOUT_MS = process.env["CUSTOMER_LINKING_TIMEOUT_MS"]
	? parseInt(process.env["CUSTOMER_LINKING_TIMEOUT_MS"])
	: 10 * 60 * 1000; // 10 minutos

const store = new JsonSessionStore<RunningSession>({ filename: "customer-linking.sessions.json" });

class CustomerLinkingBot {
	private sessions = new Map<number, RunningSession>();
	private initialized = false;
	private watcherStarted = false;

	private async ensureLoaded() {
		if (this.initialized) return;

		await store.ensureLoaded((arr) => {
			this.sessions.clear();
			const now = Date.now();

			for (const s of arr) {
				if (s && typeof s.chatId === "number") {
					this.sessions.set(s.chatId, {
						chatId: s.chatId,
						contactId: s.contactId,
						step: s.step ?? 0,
						lastActivity: s.lastActivity ?? now,
						...(s.cnpj ? { cnpj: s.cnpj } : {}),
						...(s.foundCustomerId ? { foundCustomerId: s.foundCustomerId } : {}),
						timeoutms: s.timeoutms ?? INACTIVITY_TIMEOUT_MS
					});
				}
			}
			this.initialized = true;
		});

		this.startWatcher();
	}

	private async getOrCreate(chat: WppChat, contact: WppContact): Promise<RunningSession> {
		let s = this.sessions.get(chat.id);

		if (!s) {
			// Busca timeout customizado dos parâmetros
			const params = await parametersService.getSessionParams({
				instance: chat.instance,
				sectorId: chat.sectorId!,
				userId: chat.userId!
			});
			const timeoutms = Number(params["customer_linking_timeout_ms"] || INACTIVITY_TIMEOUT_MS);

			s = {
				chatId: chat.id,
				contactId: contact.id,
				step: 0,
				lastActivity: Date.now(),
				timeoutms
			};
			this.sessions.set(chat.id, s);
			store.scheduleSave(() => this.sessions.values());
		}

		return s;
	}

	private remove(chatId: number) {
		this.sessions.delete(chatId);
		store.scheduleSave(() => this.sessions.values());
	}

	private startWatcher() {
		if (this.watcherStarted) return;
		this.watcherStarted = true;

		setInterval(async () => {
			const now = Date.now();

			for (const s of Array.from(this.sessions.values())) {
				const timeoutms = s.timeoutms ?? INACTIVITY_TIMEOUT_MS;

				if (s.step < 2 && now - s.lastActivity >= timeoutms) {
					try {
						const chat = await prismaService.wppChat.findUnique({ where: { id: s.chatId } });
						if (!chat || chat.isFinished) {
							this.remove(s.chatId);
							continue;
						}

						const logger = new ProcessingLogger(
							chat.instance,
							"customer-linking",
							`timeout-${chat.id}-${now}`,
							{
								chatId: chat.id,
								step: s.step,
								reason: "inactivity-timeout"
							}
						);

						logger.log("Sessão expirada por inatividade. Direcionando para atendimento humano.");
						await this.transferToHuman(chat, logger);

						const contact = await prismaService.wppContact.findUnique({ where: { id: s.contactId } });
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
	}

	/** Helper para enviar texto do bot */
	private async sendBotText(from: string, chat: WppChat, text: string, quotedId?: number) {
		await whatsappService.sendBotMessage(from, { chat, text, quotedId: quotedId ?? null });
	}

	/** Valida e normaliza CNPJ */
	private validateAndNormalizeCnpj(text: string): string | null {
		// Remove tudo que não é número
		const numbers = text.replace(/[^\d]/g, "");

		// CNPJ deve ter 14 dígitos
		if (numbers.length !== 14) {
			return null;
		}

		// Validação básica: não aceita CNPJs com todos os dígitos iguais
		if (/^(\d)\1{13}$/.test(numbers)) {
			return null;
		}

		return numbers;
	}

	/** Busca cliente por CNPJ na base de dados da instância */
	private async findCustomerByCnpj(
		instance: string,
		cnpj: string,
		logger?: ProcessingLogger
	): Promise<number | null> {
		try {
			logger?.log("Buscando cliente por CNPJ", { cnpj });

			// Busca na tabela de clientes da instância
			const result = await instancesService.executeQuery<
				Array<{ CODIGO: number; NOME: string; CPF_CNPJ: string }>
			>(instance, "SELECT CODIGO, NOME, CPF_CNPJ FROM clientes WHERE CPF_CNPJ = ? LIMIT 1", [cnpj]);

			if (result && result.length > 0 && result[0]) {
				logger?.log("Cliente encontrado", { customerId: result[0].CODIGO, name: result[0].NOME });
				return result[0].CODIGO;
			}

			logger?.log("Cliente não encontrado");
			return null;
		} catch (e) {
			logger?.log("Erro ao buscar cliente", { error: e });
			return null;
		}
	}

	/** Vincula o cliente ao contato */
	private async linkCustomerToContact(contactId: number, customerId: number, logger?: ProcessingLogger) {
		try {
			logger?.log("Vinculando cliente ao contato", { contactId, customerId });

			await prismaService.wppContact.update({
				where: { id: contactId },
				data: { customerId }
			});

			logger?.log("Cliente vinculado com sucesso");
		} catch (e) {
			logger?.log("Erro ao vincular cliente", { error: e });
			throw e;
		}
	}

	/** Transfere para atendimento humano */
	private async transferToHuman(chat: WppChat, logger: ProcessingLogger) {
		try {
			logger?.log("Transferindo para atendimento humano");

			await messagesDistributionService.addSystemMessage(
				chat,
				"Cliente não vinculado. Direcionando para atendimento humano.",
				false
			);

			const sector = await prismaService.wppSector.findUniqueOrThrow({ where: { id: chat.sectorId! } });
			const contact = await prismaService.wppContact.findUniqueOrThrow({ where: { id: chat.contactId! } });

			await chatsService.systemFinishChatById(chat.id, "Transferido para atendimento humano");
			const { chat: newChat } = await messagesDistributionService.createNewChat(
				chat.instance,
				[sector],
				contact,
				logger,
				true
			);
			const avatarUrl = await whatsappService.getProfilePictureUrl(newChat.instance, contact.phone);
			if (avatarUrl) {
				await prismaService.wppChat.update({
					data: { avatarUrl },
					where: { id: newChat.id }
				});
			}

			await messagesDistributionService.notifyChatStarted(logger, newChat);

			logger?.log("Chat liberado para atendimento humano");
		} catch (e) {
			logger?.log("Erro ao transferir para atendimento humano", { error: e });
			throw e;
		}
	}

	/** Finaliza o fluxo do bot com sucesso */
	private async finishBot(chat: WppChat, logger?: ProcessingLogger) {
		try {
			logger?.log("Finalizando bot com sucesso");

			// Remove o botId para liberar o chat
			await prismaService.wppChat.update({
				where: { id: chat.id },
				data: { botId: null }
			});

			logger?.log("Bot finalizado");
		} catch (e) {
			logger?.log("Erro ao finalizar bot", { error: e });
			throw e;
		}
	}

	/**
	 * Verifica se o bot deve ser ativado para este chat
	 */
	public async shouldActivate(chat: WppChat, contact: WppContact): Promise<boolean> {
		// Verifica se o contato já tem cliente vinculado
		if (await CustomerLinkingBot.hasCustomerLinked(contact)) {
			return false;
		}

		// Verifica se o bot está habilitado nos parâmetros
		const params = await parametersService.getSessionParams({
			instance: chat.instance,
			sectorId: chat.sectorId!,
			userId: -1
		});

		const enabled = params["customer_linking_bot_enabled"];
		return enabled === "true" || enabled === "1";
	}

	/**
	 * Inicia o fluxo do bot solicitando o CNPJ
	 */
	public async startBot(chat: WppChat, contact: WppContact, to: string, quotedId?: number) {
		await this.ensureLoaded();
		const session = await this.getOrCreate(chat, contact);

		const logger = new ProcessingLogger(chat.instance, "customer-linking", `start-${chat.id}-${Date.now()}`, {
			chatId: chat.id,
			contactId: contact.id
		});

		try {
			logger.log("Iniciando bot de vinculação de cliente");

			await messagesDistributionService.addSystemMessage(
				chat,
				"Iniciando processo de vinculação de cliente.",
				false
			);

			await prismaService.wppChat.update({
				where: { id: chat.id },
				data: { botId: 3 } // Usar um ID único para este bot
			});

			session.step = 0;
			session.lastActivity = Date.now();
			store.scheduleSave(() => this.sessions.values());

			logger.log("Solicitando CNPJ ao cliente");
			await this.sendBotText(to, chat, ASK_CNPJ_MSG, quotedId);

			logger.success({ step: session.step });
		} catch (err) {
			logger.failed(err);
		}
	}

	/**
	 * Processa mensagens do cliente durante o fluxo
	 */
	public async processMessage(chat: WppChat, contact: WppContact, message: WppMessage) {
		await this.ensureLoaded();
		const session = await this.getOrCreate(chat, contact);
		session.lastActivity = Date.now();
		store.scheduleSave(() => this.sessions.values());

		const instance = chat.instance;
		const from = message.from;

		const logger = new ProcessingLogger(instance, "customer-linking", `chat-${chat.id}-${Date.now()}`, {
			chatId: chat.id,
			contactId: contact.id,
			messageId: message.id,
			step: session.step
		});

		try {
			if (session.step === 0) {
				// Aguardando CNPJ
				logger.log("Step 0: aguardando CNPJ");

				const cnpj = this.validateAndNormalizeCnpj(message.body);

				if (!cnpj) {
					logger.log("CNPJ inválido recebido");
					await this.sendBotText(from, chat, INVALID_CNPJ_MSG, message.id);
					return;
				}

				logger.log("CNPJ válido recebido", { cnpj });
				session.cnpj = cnpj;

				// Busca o cliente na base de dados
				const customerId = await this.findCustomerByCnpj(instance, cnpj, logger);

				if (customerId) {
					// Cliente encontrado
					logger.log("Cliente encontrado, vinculando");
					session.foundCustomerId = customerId;

					await this.sendBotText(from, chat, CUSTOMER_FOUND_MSG, message.id);

					// Vincula o cliente ao contato
					await this.linkCustomerToContact(contact.id, customerId, logger);

					await this.sendBotText(from, chat, CUSTOMER_LINKED_MSG);

					// Finaliza o bot
					session.step = 2;
					session.lastActivity = Date.now();
					store.scheduleSave(() => this.sessions.values());

					await this.finishBot(chat, logger);
					this.remove(chat.id);

					logger.success({ step: session.step, customerId, linked: true });
				} else {
					// Cliente não encontrado
					logger.log("Cliente não encontrado, transferindo para atendimento humano");

					await this.sendBotText(from, chat, CUSTOMER_NOT_FOUND_MSG, message.id);

					// Transfere para atendimento humano
					session.step = 2;
					session.lastActivity = Date.now();
					store.scheduleSave(() => this.sessions.values());

					await this.transferToHuman(chat, logger);
					this.remove(chat.id);

					logger.success({ step: session.step, customerNotFound: true });
				}

				return;
			}

			if (session.step === 2) {
				// Bot já finalizado, não deve processar mais mensagens
				logger.log("Step 2: bot já finalizado, ignorando mensagem");
				return;
			}
		} catch (err) {
			logger.failed(err);
		}
	}

	/**
	 * Verifica se o contato já tem cliente vinculado
	 * Retorna true se já tem cliente, false se não tem
	 */
	public static async hasCustomerLinked(contact: WppContact): Promise<boolean> {
		return contact.customerId !== null && contact.customerId !== undefined;
	}

	/**
	 * Reseta a sessão manualmente
	 */
	public async reset(chatId: number, contactId: number) {
		await this.ensureLoaded();
		this.sessions.set(chatId, {
			chatId,
			contactId,
			step: 0,
			lastActivity: Date.now(),
			timeoutms: INACTIVITY_TIMEOUT_MS
		});
		store.scheduleSave(() => this.sessions.values());
	}
}

export default new CustomerLinkingBot();
