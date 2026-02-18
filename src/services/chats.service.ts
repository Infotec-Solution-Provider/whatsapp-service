import {
	Customer,
	SessionData,
	SocketEventType,
	SocketServerMonitorRoom,
	SocketServerUserRoom
} from "@in.pulse-crm/sdk";
import { Logger } from "@in.pulse-crm/utils";
import { Prisma, WppChat, WppContact, WppMessage } from "@prisma/client";
import { BadRequestError } from "@rgranatodutra/http-errors";
import exatronSatisfactionBot from "../bots/exatron-satisfaction.bot";
import { CustomerSchedule } from "../message-flow/base/base.step";
import ProcessingLogger from "../utils/processing-logger";
import instancesService from "./instances.service";
import messagesDistributionService from "./messages-distribution.service";
import prismaService from "./prisma.service";
import socketService from "./socket.service";
import getUsersClient from "./users.service";
import whatsappService, { SendTemplateData } from "./whatsapp.service";

interface InpulseResult {
	CODIGO: number;
	NOME: string;
	TIPO: "ATIVO" | "RECEP" | "AMBOS" | null;
	ESUCESSO: "SIM" | "NAO" | null;
	EVENDA: "SIM" | "NAO" | null;
	NOME_ACAO: string | null;
	ECONTATO: "SIM" | "NAO";
	COD_ACAO: number | null;
	PRIORIDADE: "SIM" | "NAO" | null;
	PROPOSTA: "SIM" | "NAO" | null;
	FIDELIZARCOTACAO: "SIM" | "NAO" | null;
	PESQUISA_SATISFACAO: "S" | "N";
	EPEDIDO: "SIM" | "NAO" | null;
	QTDE_FIDELIZARCOTACAO: number;
	ALTERA_DURACAO: "S" | "N" | null;
	CANCELAPROPOSTA: "SIM" | "NAO";
	UTILIZAR_AGENDA: "SIM" | "NAO" | null;
	NAOECOMPRA: "SIM" | "NAO";
	ECOMPRA: "SIM" | "NAO" | null;
	ENEGOCIACAO: "SIM" | "NAO" | null;
	WHATS_ACAO: string | null;
	WHATS_URGENCIA_AGENDAMENTO: "MUITO_ALTA" | "ALTA" | "MEDIA" | "NORMAL" | null;
	WHATS_ALTERAR_AGENDAMENTO: number; // 0/1
}

interface ChatsFilters {
	userId?: string;
	isFinished?: string;
}

interface SystemStartNewChatProps {
	instance: string;
	contact: WppContact;
	systemMessage?: string;
	sectorId: number;
	userId: number;
}

export const FETCH_CUSTOMERS_QUERY = "SELECT * FROM clientes WHERE CODIGO IN (?)";
const FETCH_RESULT_QUERY = "SELECT * FROM resultados WHERE CODIGO = ?";

/**
 * Converte uma data JavaScript para o formato aceito pelo MySQL: YYYY-MM-DD HH:MM:SS
 */
function formatDateForMySQL(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");

	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

class ChatsService {
	public async getChatForContact(clientId: number, contact: WppContact): Promise<WppChat | null> {
		const client = await prismaService.wppClient.findUnique({
			where: { id: clientId },
			include: { sectors: true }
		});

		if (!client || !client.sectors || client.sectors.length === 0) {
			return null;
		}

		const sectorIds = client.sectors.map(s => s.id);

		return await prismaService.wppChat.findFirst({
			where: {
				contactId: contact.id,
				isFinished: false,
				sectorId: {
					in: sectorIds
				}
			}
		});
	}

	public async getUserChatsBySession(session: SessionData, includeMessages = true, includeContact = true) {
		const foundChats = await prismaService.wppChat.findMany({
			where: {
				isFinished: false,
				instance: session.instance,
				OR: [
					{
						userId: session.userId
					},
					{
						wallet: {
							WppWalletUser: {
								some: {
									userId: session.userId
								}
							}
						}
					}
				]
			},
			include: {
				contact: {
					include: {
						WppMessage: true
					}
				},
				schedule: true
			}
		});

		if (session.role === "ADMIN") {
			const foundAdminChats = await prismaService.wppChat.findMany({
				where: {
					isFinished: false,
					sectorId: session.sectorId,
					instance: session.instance,
					userId: -1
				},
				include: {
					contact: {
						include: {
							WppMessage: true
						}
					},
					schedule: true
				}
			});

			foundChats.push(...foundAdminChats);
		}

		const chats: Array<WppChat & { customer: Customer | null; contact: WppContact | null }> = [];
		const messages: Array<WppMessage> = [];
		const customerIds = includeContact
			? foundChats
				.filter((chat) => typeof chat.contact?.customerId === "number")
				.map((c) => c.contact!.customerId!)
			: [];

		const customers = customerIds.length
			? await instancesService.executeQuery<Array<Customer>>(session.instance, FETCH_CUSTOMERS_QUERY, [
				foundChats
					.filter((chat) => typeof chat.contact?.customerId === "number")
					.map((c) => c.contact!.customerId!)
			])
			: [];

		for (const foundChat of foundChats) {
			const { contact, ...chat } = foundChat;

			let customer: Customer | null = null;

			if (includeContact && typeof contact?.customerId == "number") {
				customer = customers.find((c) => c.CODIGO === contact.customerId) || null;
			}

			chats.push({ ...chat, customer, contact: contact || null });
			if (includeMessages && contact) {
				const decodedMessages = contact.WppMessage.map((msg) => {
					if (session.instance === "vollo" && typeof msg.body === "string") {
						try {
							return {
								...msg,
								body: decodeURIComponent(msg.body)
							};
						} catch (e) {
							return msg;
						}
					}
					return msg;
				});

				messages.push(...decodedMessages);
			}
		}

		return { chats, messages };
	}

	public async getChatsMonitor(session: SessionData, includeMessages = true, includeCustomer = true) {
		const isTI = session.sectorId === 3 || session.instance !== "nunes";

		const ongoingChats = await prismaService.wppChat.findMany({
			where: {
				instance: session.instance,
				isFinished: false,
				...(isTI ? {} : { sectorId: session.sectorId })
			},
			include: {
				contact: {
					include: {
						WppMessage: includeMessages
					}
				},
				schedule: true
			}
		});

		const finishedChats = await prismaService.wppChat.findMany({
			where: {
				instance: session.instance,
				...(isTI ? {} : { sectorId: session.sectorId }),
				isFinished: true
			},
			include: {
				contact: true,
				schedule: true
			}
		});

		const chats: Array<WppChat & { customer: Customer | null; contact: WppContact | null }> = [];
		const messages: Array<WppMessage> = [];
		const customerIds = includeCustomer
			? ongoingChats
				.filter((chat) => typeof chat.contact?.customerId === "number")
				.map((c) => c.contact!.customerId!)
			: [];

		const customers = customerIds.length
			? await instancesService.executeQuery<Array<Customer>>(session.instance, FETCH_CUSTOMERS_QUERY, [
				ongoingChats
					.filter((chat) => typeof chat.contact?.customerId === "number")
					.map((c) => c.contact!.customerId!)
			])
			: [];

		for (const foundChat of ongoingChats) {
			const { contact, ...chat } = foundChat;

			let customer: Customer | null = null;

			if (includeCustomer && typeof contact?.customerId == "number") {
				customer = customers.find((c) => c.CODIGO === contact.customerId) || null;
			}

			chats.push({ ...chat, customer, contact: contact || null });

			if (includeMessages && contact) {
				const decodedMessages = contact.WppMessage.map((msg) => {
					if (session.instance === "vollo" && typeof msg.body === "string") {
						try {
							return {
								...msg,
								body: decodeURIComponent(msg.body)
							};
						} catch (e) {
							return msg;
						}
					}
					return msg;
				});

				messages.push(...decodedMessages);
			}
		}

		for (const foundChat of finishedChats) {
			const { contact, ...chat } = foundChat;

			let customer: Customer | null = null;

			if (includeCustomer && typeof contact?.customerId == "number") {
				customer = customers.find((c) => c.CODIGO === contact.customerId) || null;
			}

			chats.push({ ...chat, customer, contact: contact || null });
		}

		return { chats, messages };
	}

	public async getChats(filters: ChatsFilters) {
		const whereClause: Prisma.WppChatWhereInput = {};

		if (filters.userId) {
			whereClause.userId = +filters.userId;
		}

		if (filters.isFinished) {
			whereClause.isFinished = filters.isFinished === "true" ? true : false;
		}

		const chats = await prismaService.wppChat.findMany({
			include: {
				messages: true,
				contact: true,
				schedule: true
			},
			where: whereClause
		});

		return chats;
	}

	public async getChatById(id: number) {
		const chat = await prismaService.wppChat.findUnique({
			where: { id },
			include: {
				contact: true
			}
		});

		const messages = chat?.contactId
			? await prismaService.wppMessage.findMany({
				where: { contactId: chat?.contactId },
				orderBy: { timestamp: "asc" }
			})
			: [];

		if (chat?.contact?.customerId) {

			try {
				const customerRes = await instancesService.executeQuery<Customer[]>(
					chat.instance,
					FETCH_CUSTOMERS_QUERY,
					[[chat.contact.customerId]]
				);
				const customer = customerRes[0];

				return { ...chat, customer, messages };
			} catch (err: any) {
				Logger.error("Erro ao buscar cliente para o chat:", err);
				return { ...chat, messages };
			}
		}

		return { ...chat, messages };
	}

	public async transferAttendance(token: string, session: SessionData, id: number, userId: number) {
		const { instance } = session;

		const usersService = getUsersClient();
		usersService.setAuth(token);

		const chats = await prismaService.wppChat.findUnique({
			where: { id }
		});
		if (!chats) {
			throw new Error("Chat não encontrado!");
		}
		if (!chats.userId) {
			throw new Error("Chat não possui userId!");
		}
		const user = await usersService.getUserById(chats.userId);

		const chat = await prismaService.wppChat.update({
			where: { id },
			data: {
				userId
			}
		});

		await this.syncChatToLocal(chat);

		const event = SocketEventType.WppChatTransfer;
		const monitorRoom: SocketServerMonitorRoom = `${chat.instance}:${chat.sectorId!}:monitor`;

		if (chat.userId === null || chat.userId === undefined) {
			throw new Error("chat.userId is null or undefined, cannot construct userRoom.");
		}

		const userRoom: SocketServerUserRoom = `${chat.instance}:user:${chat.userId}`;

		const transferMsg = `Atendimento transferido por ${user.NOME}.`;
		await messagesDistributionService.addSystemMessage(chat, transferMsg);
		await socketService.emit(event, `${instance}:chat:${chat.id}`, {
			chatId: chat.id
		});
		await socketService.emit(SocketEventType.WppChatStarted, monitorRoom, {
			chatId: chat.id
		});
		await socketService.emit(SocketEventType.WppChatStarted, userRoom, {
			chatId: chat.id
		});
	}

	public async finishChatById(
		token: string | null,
		session: SessionData,
		id: number,
		resultId: number,
		scheduleDate: Date | null,
		reason?: string
	) {
		const logger = new ProcessingLogger(
			session.instance,
			"finish-chat",
			`chat_${id}_result_${resultId}_${Date.now()}`,
			{ chatId: id, resultId, userId: session.userId, reason }
		);

		try {
			logger.log(`Iniciando finalização do chat. Chat ID: ${id}, Resultado ID: ${resultId}`);

			logger.log(`Buscando resultado no banco de dados da instância com resultId: ${resultId}`);
			const results = await instancesService.executeQuery<InpulseResult[]>(session.instance, FETCH_RESULT_QUERY, [
				resultId
			]);

			const result = results[0];
			if (result) {
				logger.log(`Resultado encontrado. Nome: ${result.NOME}, Código: ${result.CODIGO}`);
			} else {
				logger.log(`Aviso: Resultado não encontrado para resultId ${resultId}`);
			}

			const { instance, userId } = session;
			const usersService = getUsersClient();
			usersService.setAuth(token || "");

			logger.log(`Buscando usuário que finalizou o atendimento. UserId: ${userId}`);
			const user = resultId !== -50 && (await usersService.getUserById(userId));
			if (user) {
				logger.log(`Usuário encontrado: ${user.NOME} (ID: ${user.CODIGO})`);
			} else {
				logger.log(`Chat finalizado pelo sistema (resultId: -50 ou usuário não encontrado)`);
			}

			logger.log(`Atualizando chat no banco de dados. Marcando como finalizado`);
			const finishedAt = new Date();
			const updateResult = await prismaService.wppChat.updateMany({
				where: {
					id,
					isFinished: false
				},
				data: {
					isFinished: true,
					finishedAt,
					finishedBy: userId,
					resultId
				}
			});

			if (updateResult.count === 0) {
				logger.log(`Chat já estava finalizado. Ignorando nova tentativa de finalização. Chat ID: ${id}`);
				logger.success(`Finalização ignorada (idempotência). Chat ID: ${id}`);
				return;
			}

			const chat = await prismaService.wppChat.findUnique({
				where: { id },
				include: {
					contact: true
				}
			});

			if (!chat) {
				throw new Error(`Chat ${id} não encontrado após finalização`);
			}

			const event = SocketEventType.WppChatFinished;
			await socketService.emit(event, `${instance}:chat:${chat.id}`, {
				chatId: chat.id
			});

			await this.syncChatToLocal(chat);

			logger.log(
				`Chat atualizado com sucesso. Chat ID: ${chat.id}, Status: finalizado, Resultado ID: ${chat.resultId}`
			);



			let finishMsg: string = "";

			if (!user && resultId === -50) {
				finishMsg = `Atendimento finalizado pelo sistema.` + (reason ? `\nMotivo: ${reason}` : "");
				logger.log(`Mensagem do sistema: "${finishMsg}"`);
			}
			if (user) {
				finishMsg = `Atendimento finalizado por ${user.NOME}.\nResultado: ${results[0]?.NOME || "N/D"} `;
				logger.log(`Mensagem do usuário: "${finishMsg}"`);
			}

			logger.log(`Adicionando mensagem de sistema ao chat`);
			await messagesDistributionService.addSystemMessage(chat, finishMsg);
			logger.log(`Mensagem de sistema adicionada com sucesso`);

			logger.log(`Emitindo evento de chat finalizado via socket para a sala: ${instance}:chat:${chat.id}`);

			logger.log(`Evento de socket emitido com sucesso`);

			if (chat.contact?.customerId && result) {
				logger.log(`Chat possui contato com cliente vinculado. Customer ID: ${chat.contact.customerId}`);

				logger.log(
					`Iniciando processo de fidelização. FIDELIZARCOTACAO: ${result?.FIDELIZARCOTACAO}, EVENDA: ${result?.EVENDA}`
				);

				const customer = await instancesService.executeQuery<Customer[]>(chat.instance, FETCH_CUSTOMERS_QUERY, [
					[chat.contact.customerId]
				]);

				if (customer[0] && user) {
					logger.log(
						`Cliente encontrado no banco de dados: ${customer[0].RAZAO} (ID: ${customer[0].CODIGO})`
					);
					await this.handleInpulseFidelization(
						chat.contact!,
						customer[0],
						chat,
						result,
						user.LOGIN,
						scheduleDate
					);
					logger.log(`Fidelização processada com sucesso`);
				} else {
					logger.log(`Aviso: Cliente não encontrado na base de dados para ID: ${chat.contact.customerId}`);
				}
			} else {
				logger.log(`Chat sem contato ou cliente vinculado. Pulando fidelização`);
			}

			if (result && result.WHATS_ACAO === "trigger-survey") {
				logger.log(`Iniciando bot de satisfação. WHATS_ACAO: ${result?.WHATS_ACAO}`);
				await exatronSatisfactionBot.startBot(chat, chat.contact!, chat.contact!.phone);
				logger.log(`Bot de satisfação iniciado com sucesso`);
			} else {
				logger.log(`Bot de satisfação não será acionado. WHATS_ACAO: ${result?.WHATS_ACAO}`);
			}

			logger.success(`Chat finalizado com sucesso. Chat ID: ${chat.id}`);
		} catch (err) {
			logger.log(`Erro durante a finalização do chat: ${err instanceof Error ? err.message : String(err)}`);
			logger.log(`Stack trace: ${err instanceof Error ? err.stack : "N/A"}`);
			logger.failed(err);
			throw err;
		}
	}

	public async handleInpulseFidelization(
		contact: WppContact,
		customer: Customer,
		chat: WppChat,
		result: InpulseResult,
		userLogin: string,
		scheduleDate?: Date | null
	) {
		const logger = new ProcessingLogger(
			chat.instance,
			"fidelization",
			`customer_${customer.CODIGO}_chat_${chat.id}_${Date.now()}`,
			{ customerId: customer.CODIGO, chatId: chat.id, resultId: result.CODIGO }
		);

		try {
			logger.log(`Iniciando processamento de fidelização`);
			logger.log(`FIDELIZARCOTACAO: ${result.FIDELIZARCOTACAO}, UserId válido: ${(chat.userId || 0) > 0}`);
			logger.log(`Buscando última campanha para customer ${customer.CODIGO}`);
			const lastCampaign = await this.getLastInpulseSchedule(chat.instance, customer.CODIGO);

			if (!lastCampaign) {
				logger.log(`Aviso: Nenhuma campanha encontrada para customer ${customer.CODIGO}`);
				return;
			}

			await this.createHistoricoCli(lastCampaign, chat, contact, result, userLogin);

			if (result.FIDELIZARCOTACAO !== "SIM" || !((chat.userId || 0) > 0)) {
				logger.log(`Fidelização não necessária. Finalizando`);
				return;
			}

			logger.log(`Campanha encontrada. Código: ${lastCampaign.CODIGO}, Concluído: ${lastCampaign.CONCLUIDO}`);

			logger.log(`Criando histórico do cliente`);

			logger.log(`Histórico criado com sucesso`);

			if (lastCampaign.OPERADOR == -2) {
				logger.log(`Operador da campanha é -2. Finalizando sem agendar`);
				return;
			}

			logger.log(`Calculando nova data de agendamento baseado no código de ação: ${result.COD_ACAO}`);
			const newScheduleDate = await this.getScheduleDate(result, scheduleDate);

			if (newScheduleDate && lastCampaign.CONCLUIDO == "NAO") {
				logger.log(
					`Atualizando data de agendamento da campanha existente para: ${newScheduleDate.toISOString()}`
				);
				const updateQuery = `UPDATE campanhas_clientes SET DT_AGENDAMENTO = ?, OPERADOR = ? WHERE CODIGO = ?`;
				await instancesService.executeQuery(chat.instance, updateQuery, [
					formatDateForMySQL(newScheduleDate),
					chat.userId,
					lastCampaign.CODIGO
				]);
				logger.log(`Campanha atualizada com sucesso`);
			} else if (newScheduleDate && lastCampaign.CONCLUIDO == "SIM") {
				logger.log(`Criando nova campanha agendada para: ${newScheduleDate.toISOString()}`);
				const insertQueryKeys = {
					CLIENTE: contact.customerId,
					CAMPANHA: lastCampaign.CAMPANHA,
					DT_AGENDAMENTO: formatDateForMySQL(newScheduleDate),
					CONCLUIDO: "NAO",
					FONE1: lastCampaign.FONE1,
					FONE2: lastCampaign.FONE2,
					FONE3: lastCampaign.FONE3,
					ORDEM: lastCampaign.ORDEM,
					OPERADOR: chat.userId
				};

				const insertQuery = `INSERT INTO campanhas_clientes (${Object.keys(insertQueryKeys).join(", ")}) VALUES (${Object.keys(
					insertQueryKeys
				)
					.map(() => "?")
					.join(", ")})`;
				const insertValues = Object.values(insertQueryKeys);

				await instancesService.executeQuery(chat.instance, insertQuery, insertValues);
				logger.log(`Nova campanha criada com sucesso`);
			} else {
				logger.log(`Nenhuma data de agendamento calculada. Concluído: ${lastCampaign.CONCLUIDO}`);
			}

			if (result.FIDELIZARCOTACAO === "SIM") {
				logger.log(`Criando fidelizações para a campanha`);
				await this.createFidelizacoes(chat, contact, result, lastCampaign);
				logger.log(`Fidelizações criadas com sucesso`);
			}

			logger.success(`Fidelização processada com sucesso`);
		} catch (err) {
			logger.log(`Erro durante fidelização: ${err instanceof Error ? err.message : String(err)}`);
			logger.failed(err);
			throw err;
		}
	}

	private async getScheduleDate(result: InpulseResult, scheduleDate?: Date | null) {
		const now = new Date();
		switch (result.COD_ACAO) {
			case 2:
				return scheduleDate || null;
			case 3:
				now.setMinutes(now.getMinutes() + 20);
				return now;
			case 4:
				now.setMonth(now.getMonth() + 1);
				return now;
			case 5:
				now.setMonth(now.getMonth() + 6);
				return now;
			case 11:
				now.setDate(now.getDate() + 1);
				return now;
			case 12:
				now.setDate(now.getDate() + 7);
				return now;
			case 13:
				now.setMonth(now.getMonth() + 3);
				return now;
			case 15:
				now.setMonth(now.getMonth() + 2);
				return now;
			case 16:
				now.setFullYear(now.getFullYear() + 1);
				return now;
			case 18:
				now.setHours(now.getHours() + 1);
				return now;
			case 19:
				now.setDate(now.getDate() + 2);
				return now;
			case 20:
				now.setDate(now.getDate() + 40);
				return now;
			default:
				return null;
		}
	}

	private async getLastInpulseSchedule(instance: string, customerId: number) {
		const query = "SELECT * FROM campanhas_clientes cc WHERE cc.CLIENTE = ? ORDER BY cc.CODIGO DESC LIMIT 1";
		const lastCampaign = await instancesService.executeQuery<CustomerSchedule[]>(instance, query, [customerId]);

		return lastCampaign[0] || null;
	}

	private async createHistoricoCli(
		lastIS: CustomerSchedule,
		chat: WppChat,
		contact: WppContact,
		result: InpulseResult,
		userLogin: string
	) {
		const logger = new ProcessingLogger(
			chat.instance,
			"historico-cli",
			`campaign_${lastIS.CODIGO}_chat_${chat.id}_${Date.now()}`,
			{ campaignCode: lastIS.CODIGO, chatId: chat.id }
		);

		try {
			logger.log(`Criando registro de histórico do cliente`);
			logger.log(`Campanha: ${lastIS.CAMPANHA}, Resultado: ${result.NOME}, Telefone: ${contact.phone}`);

			const campanha = await instancesService.executeQuery<any>(
				chat.instance,
				"SELECT * FROM campanhas WHERE CODIGO = ?",
				[lastIS.CAMPANHA]
			);

			if (!campanha || !campanha[0]) {
				logger.log(`Aviso: Campanha não encontrada para código ${lastIS.CAMPANHA}. Pulando criação de histórico.`);
				return null;
			}

			const ATIVO_RECEP = chat.type === "ACTIVE" ? "ATIVO" : "RECEP";
			const data = formatDateForMySQL(chat.finishedAt || new Date());
			const dto = {
				CAMPANHA: campanha[0]["NOME"],
				ATIVO_RECEP: ATIVO_RECEP,
				OPERADOR: userLogin,
				DATAHORA_INICIO: data,
				DATAHORA_FIM: data,
				RESULTADO: result.CODIGO,
				TELEFONE: contact.phone,
				OBSERVACAO: `Atendimento via WhatsApp - Código: ${chat.id}`,
				CLIENTE: contact.customerId,
				CC_CODIGO: lastIS.CODIGO
			};
			const query = `INSERT INTO historico_cli (${Object.keys(dto).join(", ")}) VALUES (${Object.keys(dto)
				.map(() => "?")
				.join(", ")})`;

			logger.log(
				`Inserindo registro com dados: ATIVO_RECEP=${ATIVO_RECEP}, OPERADOR=${chat.userId}, RESULTADO=${result.CODIGO}`
			);
			const historicoCli = await instancesService.executeQuery(chat.instance, query, Object.values(dto));

			logger.log(`Histórico do cliente criado com sucesso`);
			logger.success(`Histórico criado`);
			return historicoCli;
		} catch (err) {
			logger.log(`Erro ao criar histórico do cliente: ${err instanceof Error ? err.message : String(err)}`);
			logger.failed(err);
			throw err;
		}
	}

	private async createFidelizacoes(
		chat: WppChat,
		contact: WppContact,
		result: InpulseResult,
		lastCampaign: CustomerSchedule
	) {
		const logger = new ProcessingLogger(
			chat.instance,
			"create-fidelizacoes",
			`campaign_${lastCampaign.CODIGO}_chat_${chat.id}_${Date.now()}`,
			{ campaignCode: lastCampaign.CODIGO, chatId: chat.id, quantity: result.QTDE_FIDELIZARCOTACAO }
		);

		try {
			logger.log(`Criando registros de fidelização`);
			logger.log(
				`Cliente: ${contact.customerId}, Quantidade: ${result.QTDE_FIDELIZARCOTACAO}, Campanha: ${lastCampaign.CODIGO}`
			);

			const insertQueryKeys = {
				cliente: contact.customerId,
				cc_codigo: lastCampaign.CODIGO,
				qtde_fidelizar: result.QTDE_FIDELIZARCOTACAO,
				dt_criacao: formatDateForMySQL(new Date()),
				operador_criacao: chat.userId
			};

			const insertQuery = `INSERT INTO fidelizacoes (${Object.keys(insertQueryKeys).join(", ")}) VALUES (${Object.keys(
				insertQueryKeys
			)
				.map(() => "?")
				.join(", ")})`;
			const insertValues = Object.values(insertQueryKeys);

			logger.log(`Executando query de inserção de fidelizações`);
			await instancesService.executeQuery(chat.instance, insertQuery, insertValues);

			logger.log(`Fidelizações criadas com sucesso`);
			logger.success(`Fidelizações criadas`);
		} catch (err) {
			logger.log(`Erro ao criar fidelizações: ${err instanceof Error ? err.message : String(err)}`);
			logger.failed(err);
			throw err;
		}
	}

	public async systemFinishChatById(chatId: number, reason: string) {
		const logger = new ProcessingLogger("system", "system-finish-chat", `chat_${chatId}_${Date.now()}`, {
			chatId,
			reason
		});

		try {
			logger.log(`Iniciando finalização do chat pelo sistema. Chat ID: ${chatId}, Motivo: ${reason}`);

			logger.log(`Buscando chat no banco de dados`);
			const chat = await prismaService.wppChat.findUnique({
				where: { id: chatId },
				include: { contact: true }
			});

			if (!chat) {
				logger.log(`Erro: Chat não encontrado. Chat ID: ${chatId}`);
				throw new Error("Chat not found");
			}

			logger.log(
				`Chat encontrado. Instance: ${chat.instance}, Setor: ${chat.sectorId}, Contato: ${chat.contact?.phone}`
			);

			if (chat.isFinished) {
				logger.log(`Chat já estava finalizado. Interrompendo`);
				return;
			}

			logger.log(`Chat ainda está ativo. Procedendo com a finalização`);

			await this.finishChatById(
				null,
				{ instance: chat.instance, userId: -1, sectorId: -1, role: "ADMIN", name: "SYSTEM" },
				chatId,
				-50,
				null,
				reason
			);

			logger.success(`Chat finalizado pelo sistema com sucesso`);
		} catch (err) {
			logger.log(`Erro ao finalizar chat pelo sistema: ${err instanceof Error ? err.message : String(err)}`);
			logger.failed(err);
			throw err;
		}
	}

	public async startChatByContactId(
		session: SessionData,
		token: string,
		contactId: number,
		template?: SendTemplateData
	) {
		const process = new ProcessingLogger(
			session.instance,
			"start-chat",
			`${session.userId}-${contactId}_${Date.now()}`,
			{ session, contactId, token }
		);

		try {
			const contact = await prismaService.wppContact.findUnique({
				where: { id: contactId }
			});

			if (!contact) {
				throw new Error("Contato não encontrado!");
			}

			await this.checkIfChatExistsOrThrow(session.instance, contact.id);

			const profilePicture = await whatsappService.getProfilePictureUrl(session.instance, contact.phone);
			const newChat = await prismaService.wppChat.create({
				data: {
					instance: session.instance,
					type: "ACTIVE",
					avatarUrl: profilePicture,
					userId: session.userId,
					contactId,
					sectorId: session.sectorId,
					startedAt: new Date()
				},
				include: {
					contact: true,
					messages: {
						where: {
							contactId: contact.id
						}
					}
				}
			});
			;
			await this.syncChatToLocal(newChat);

			const usersService = getUsersClient();
			usersService.setAuth(token);
			const user = await usersService.getUserById(session.userId);

			const message = `Atendimento iniciado por ${user.NOME}.`;
			await messagesDistributionService.addSystemMessage(newChat as WppChat, message, true);
			const sector = await prismaService.wppSector.findUnique({ where: { id: session.sectorId } });

			if (!sector || !sector.defaultClientId) {
				throw new BadRequestError("Nenhum cliente WhatsApp padrão configurado para o setor do usuário.");
			}
			const client = whatsappService.getClient(sector.defaultClientId);

			if (!client) {
				throw new BadRequestError("Nenhum cliente WhatsApp encontrado para o setor especificado.");
			}

			if (template && newChat.contact) {
				await whatsappService.sendTemplate(
					session,
					client.id,
					newChat.contact.phone,
					template,
					newChat.id,
					newChat.contact.id
				);
			}

			await messagesDistributionService.notifyChatStarted(process, newChat as WppChat);

			console.log(`[startChatByContactId] Chat ${newChat.id} finalizado com sucesso`);

			return newChat;
		} catch (err) {
			process.log("Erro ao iniciar o atendimento ");
			process.failed(err);
			console.error(`[startChatByContactId] Erro:`, err);
			throw err;
		}
	}

	public async systemStartNewChat({ instance, sectorId, userId, contact, systemMessage }: SystemStartNewChatProps) {
		const process = new ProcessingLogger(instance, "system-start-chat", `system-${contact.id}-${Date.now()}`, {
			instance,
			contactId: contact.id
		});

		try {
			process.log(`Starting chat for contact ID ${contact.id} in instance ${instance}`);
			process.log("Checking if chat already exists...");
			await this.checkIfChatExistsOrThrow(instance, contact.id);
			process.log("No existing chat found, proceeding to create a new chat...");

			const profilePicture = await whatsappService.getProfilePictureUrl(instance, contact.phone);
			const newChat = await prismaService.wppChat.create({
				data: {
					instance,
					type: "ACTIVE",
					avatarUrl: profilePicture,
					userId,
					contactId: contact.id,
					sectorId,
					startedAt: new Date()
				},
				include: {
					contact: true,
					messages: {
						where: {
							contactId: contact.id
						}
					}
				}
			});
			process.log(`Chat created with ID ${newChat.id}`);

			await this.syncChatToLocal(newChat);

			const message = systemMessage || `Atendimento iniciado pelo sistema.`;
			await messagesDistributionService.addSystemMessage(newChat as WppChat, message, true);
			await messagesDistributionService.notifyChatStarted(process, newChat as WppChat);

			return newChat;
		} catch (err: any) {
			process.log("Erro ao iniciar o atendimento pelo sistema:" + err.message);
			process.failed(err);
			throw new Error("Erro ao iniciar o atendimento pelo sistema: " + err.message, { cause: err });
		}
	}

	private async checkIfChatExistsOrThrow(instance: string, contactId: number) {
		const existingChat = await prismaService.wppChat.findFirst({
			where: {
				instance,
				contactId,
				isFinished: false
			}
		});
		if (existingChat) {
			throw new Error("Alguém já está atendendo esse contato!");
		}
	}

	private formatDateForMySQL(date: Date | null | undefined): string | null {
		if (!date) return null;

		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		const hours = String(date.getHours()).padStart(2, "0");
		const minutes = String(date.getMinutes()).padStart(2, "0");
		const seconds = String(date.getSeconds()).padStart(2, "0");

		return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
	}

	public async syncChatToLocal(chat: WppChat) {
		try {
			const startedAt = this.formatDateForMySQL(chat.startedAt);
			const finishedAt = this.formatDateForMySQL(chat.finishedAt);

			const query = `
				INSERT INTO wpp_chats (
					id, original_id, instance, type, avatar_url, user_id, contact_id, 
					sector_id, started_at, finished_at, finished_by, 
					result_id, is_finished, is_schedule
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					type = VALUES(type),
					avatar_url = VALUES(avatar_url),
					user_id = VALUES(user_id),
					contact_id = VALUES(contact_id),
					sector_id = VALUES(sector_id),
					started_at = VALUES(started_at),
					finished_at = VALUES(finished_at),
					finished_by = VALUES(finished_by),
					result_id = VALUES(result_id),
					is_finished = VALUES(is_finished),
					is_schedule = VALUES(is_schedule)
			`;

			await instancesService.executeQuery(chat.instance, query, [
				chat.id,
				chat.id,
				chat.instance,
				chat.type,
				chat.avatarUrl,
				chat.userId,
				chat.contactId,
				chat.sectorId,
				startedAt,
				finishedAt,
				chat.finishedBy,
				chat.resultId,
				chat.isFinished,
				chat.isSchedule
			]);
		} catch (error) {
			console.error("[syncChatToLocal] Erro ao sincronizar chat:", error);
			throw error;
		}
	}
}

export default new ChatsService();
