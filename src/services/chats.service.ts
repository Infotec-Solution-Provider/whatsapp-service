import { Customer, SessionData, SocketEventType, SocketServerMonitorRoom, SocketServerUserRoom } from "../sdk-local";
import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { Prisma, WppChat, WppContact, WppMessage, WppSector } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import { TemplateMessage } from "../adapters/template.adapter";
import exatronSatisfactionBot from "../bots/exatron-satisfaction.bot";
import { CustomerSchedule } from "../message-flow/base/base.step";
import ProcessingLogger from "../utils/processing-logger";
import instancesService from "./instances.service";
import messagesDistributionService from "./messages-distribution.service";
import prismaService from "./prisma.service";
import socketService from "./socket.service";
import transferHistoryService from "./transfer-history.service";
import getUsersClient from "./users.service";
import whatsappService, { SendTemplateData } from "./whatsapp.service";
import parametersService from "./parameters.service";
import contactsService from "./contacts.service";
import { withPublicMessageDirection } from "../utils/public-message-direction";
import {
	ChatScope,
	buildAgentFinishMessage,
	buildAgentTransferHistoryReason,
	buildAgentTransferMessage,
	buildSyntheticSession,
	buildSystemFinishMessage
} from "../utils/chat-scope";
import { TemplateVariables } from "../types/whatsapp-api.types";
import messagePresentationService from "./message-presentation.service";
import chatUserPreferencesService from "./chat-user-preferences.service";
import publicReportFieldsService from "./public-report-fields.service";

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

export interface PublicConversationsFilters {
	page: number;
	limit: number;
	isFinished?: boolean;
	userId?: number;
	sectorId?: number;
	contactId?: number;
	search?: string;
	startedFrom?: Date;
	startedTo?: Date;
	finishedFrom?: Date;
	finishedTo?: Date;
}

interface SystemStartNewChatProps {
	instance: string;
	contact: WppContact;
	systemMessage?: string;
	sectorId?: number | null;
	userId?: number | null;
	agentId?: number | null;
}

interface EnsureActiveChatForAgentProps {
	instance: string;
	contactId: number;
	/** Opcional: “Iniciar chat” do Assistente cria o chat sem agente (agent_id nulo). */
	agentId?: number | null;
	systemMessage?: string;
	sectorId?: number | null;
	userId?: number | null;
}

interface SendInternalAgentMessageData {
	clientId?: number | null;
	text?: string | null;
	fileId?: number | null;
	quotedId?: number | null;
	agentId?: number | null;
	/** Tenant do chat; sem ele, busca sem escopo (ai-service antigo). */
	instance?: string | null;
}

export interface AgentTransferInput {
	instance: string;
	agentId: number;
	agentName?: string | null;
	userId: number;
	reason?: string | null;
}

export interface AgentFinishInput {
	instance: string;
	agentId: number;
	agentName?: string | null;
	resultId?: number | null;
	reason?: string | null;
}

export interface AgentSendTemplateInput {
	instance: string;
	agentId: number;
	clientId?: number | null;
	templateName: string;
	templateLanguage?: string | null;
	templateVariables: TemplateVariables;
	components: string[];
}

const FETCH_OPERATOR_NAME_QUERY = "SELECT NOME FROM operadores WHERE CODIGO = ?";

/**
 * Repassa o erro HTTP sem a causa original: a causa pode trazer a configuração da
 * chamada ao provedor (com credenciais) e iria inteira no corpo da resposta.
 */
function withoutErrorCause(error: unknown) {
	if (error instanceof BadRequestError) {
		return new BadRequestError(error.message);
	}

	return error;
}

export const FETCH_CUSTOMERS_QUERY = "SELECT * FROM clientes WHERE CODIGO IN (?)";
const PUBLIC_CUSTOMERS_QUERY = "SELECT CODIGO, RAZAO, CPF_CNPJ, COD_ERP FROM clientes WHERE CODIGO IN (?)";

interface PublicCustomerRow {
	CODIGO: number | string;
	RAZAO: string | null;
	CPF_CNPJ: string | null;
	COD_ERP: string | null;
}
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

		const sectorIds = client.sectors.map((s) => s.id);

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
			include: { contact: true, schedule: true }
		});

		if (session.role === "ADMIN") {
			const foundAdminChats = await prismaService.wppChat.findMany({
				where: {
					isFinished: false,
					sectorId: session.sectorId,
					instance: session.instance,
					userId: -1
				},
				include: { contact: true, schedule: true }
			});

			foundChats.push(...foundAdminChats);
		}
		const preferences = await chatUserPreferencesService.getMap(
			session,
			foundChats.map((chat) => chat.id),
			"wpp"
		);

		const chats: Array<
			WppChat & {
				customer: Customer | null;
				contact: WppContact | null;
				lastMessage?: WppMessage | null;
				isUnread?: boolean;
				isPinned?: boolean;
			}
		> = [];
		const contactIds = foundChats
			.map((chat) => chat.contactId)
			.filter((contactId): contactId is number => typeof contactId === "number");
		const messages: Array<WppMessage> =
			includeMessages && contactIds.length
				? await prismaService.wppMessage.findMany({
						where: { instance: session.instance, contactId: { in: contactIds } }
					})
				: [];
		const lastMessageByContact = new Map<number, WppMessage>();
		const unreadContactIds = new Set<number>();

		if (!includeMessages && contactIds.length) {
			const [lastMessageGroups, unreadMessages] = await Promise.all([
				prismaService.wppMessage.groupBy({
					by: ["contactId"],
					where: { instance: session.instance, contactId: { in: contactIds } },
					_max: { id: true }
				}),
				prismaService.wppMessage.findMany({
					where: {
						instance: session.instance,
						contactId: { in: contactIds },
						status: { not: "READ" },
						AND: [
							{ from: { not: { startsWith: "me" } } },
							{ from: { not: { startsWith: "system" } } },
							{ from: { not: { startsWith: "bot" } } },
							{ from: { not: { startsWith: "thirdparty" } } }
						]
					},
					select: { contactId: true },
					distinct: ["contactId"]
				})
			]);
			const lastMessageIds = lastMessageGroups
				.map((group) => group._max.id)
				.filter((id): id is number => typeof id === "number");
			const lastMessages = lastMessageIds.length
				? await prismaService.wppMessage.findMany({ where: { id: { in: lastMessageIds } } })
				: [];

			for (const message of lastMessages) {
				if (message.contactId !== null) lastMessageByContact.set(message.contactId, message);
			}
			for (const message of unreadMessages) {
				if (message.contactId !== null) unreadContactIds.add(message.contactId);
			}
		}
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

			const contactId = contact?.id;
			const lastMessage = contactId ? lastMessageByContact.get(contactId) || null : null;
			const preference = preferences.get(`wpp:${foundChat.id}`);
			chats.push({
				...chat,
				customer,
				contact: contact || null,
				isPinned: preference?.isPinned ?? false,
				...(!includeMessages ? { lastMessage, isUnread: !!contactId && unreadContactIds.has(contactId) } : {}),
				...(preference?.isMarkedUnread ? { isUnread: true } : {})
			});
		}

		if (session.instance === "vollo") {
			for (const message of [...messages, ...chats.flatMap((chat) => chat.lastMessage ? [chat.lastMessage] : [])]) {
				try {
					message.body = decodeURIComponent(message.body);
				} catch {
					// Keep the original body when it is not URI encoded.
				}
			}
		}

		const presentedLastMessages = await messagePresentationService.hydrate(
			session.instance,
			chats.flatMap((chat) => (chat.lastMessage ? [chat.lastMessage] : []))
		);
		const lastMessagesById = new Map(presentedLastMessages.map((message) => [message.id, message]));
		return {
			chats: chats.map((chat) => ({
				...chat,
				...(chat.lastMessage ? { lastMessage: lastMessagesById.get(chat.lastMessage.id) } : {})
			})),
			messages: await messagePresentationService.hydrate(session.instance, messages)
		};
	}

	/**
	 * Página de mensagens de um chat do tenant do escopo (e do setor, quando o escopo
	 * trouxer). A sessão usa messagesScopeFromSession; a rota interna, só o tenant.
	 */
	public async getChatMessagesPage(scope: ChatScope, chatId: number, limit: number, beforeId: number | null) {
		const { instance } = scope;
		const chat = await prismaService.wppChat.findFirst({
			where: {
				id: chatId,
				instance,
				...(scope.sectorId !== null && scope.sectorId !== undefined ? { sectorId: scope.sectorId } : {})
			},
			select: { id: true }
		});

		if (!chat) throw new BadRequestError("Chat not found!");

		const page = await prismaService.wppMessage.findMany({
			where: {
				instance,
				chatId,
				...(beforeId ? { id: { lt: beforeId } } : {})
			},
			orderBy: { id: "desc" },
			take: limit + 1
		});
		const hasMore = page.length > limit;
		const messages = page.slice(0, limit).reverse();
		if (instance === "vollo") {
			for (const message of messages) {
				try {
					message.body = decodeURIComponent(message.body);
				} catch {
					// Keep the original body when it is not URI encoded.
				}
			}
		}
		const quotedIds = messages
			.map((message) => message.quotedId)
			.filter((id): id is number => typeof id === "number");
		const quotedMessages = quotedIds.length
			? await prismaService.wppMessage.findMany({
					where: { id: { in: quotedIds }, instance }
				})
			: [];
		if (instance === "vollo") {
			for (const message of quotedMessages) {
				try {
					message.body = decodeURIComponent(message.body);
				} catch {
					// Keep the original body when it is not URI encoded.
				}
			}
		}

		return {
			messages: (await messagePresentationService.hydrate(instance, messages)).map(withPublicMessageDirection),
			quotedMessages: (await messagePresentationService.hydrate(instance, quotedMessages)).map(
				withPublicMessageDirection
			),
			nextCursor: hasMore && messages.length ? messages[0]!.id : null
		};
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

		return { chats, messages: await messagePresentationService.hydrate(session.instance, messages) };
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

	public async getPublicConversations(session: SessionData, filters: PublicConversationsFilters) {
		const where: Prisma.WppChatWhereInput = {
			instance: session.instance,
			...(filters.isFinished === undefined ? {} : { isFinished: filters.isFinished }),
			...(filters.userId === undefined ? {} : { userId: filters.userId }),
			...(filters.sectorId === undefined ? {} : { sectorId: filters.sectorId }),
			...(filters.contactId === undefined ? {} : { contactId: filters.contactId }),
			...(filters.startedFrom || filters.startedTo
				? {
						startedAt: {
							...(filters.startedFrom ? { gte: filters.startedFrom } : {}),
							...(filters.startedTo ? { lte: filters.startedTo } : {})
						}
					}
				: {}),
			...(filters.finishedFrom || filters.finishedTo
				? {
						finishedAt: {
							...(filters.finishedFrom ? { gte: filters.finishedFrom } : {}),
							...(filters.finishedTo ? { lte: filters.finishedTo } : {})
						}
					}
				: {}),
			...(filters.search
				? {
						contact: {
							OR: [
								{ name: { contains: filters.search } },
								{ phone: { contains: filters.search } },
								{ whatsappId: { contains: filters.search } }
							]
						}
					}
				: {})
		};

		const skip = (filters.page - 1) * filters.limit;
		const [total, items] = await Promise.all([
			prismaService.wppChat.count({ where }),
			prismaService.wppChat.findMany({
				where,
				skip,
				take: filters.limit,
				orderBy: [{ startedAt: "desc" }, { id: "desc" }],
				include: {
					contact: true,
					sector: true,
					_count: { select: { messages: true } }
				}
			})
		]);

		return {
			items: await this.presentPublicConversations(session.instance, items),
			pagination: {
				page: filters.page,
				limit: filters.limit,
				total,
				totalPages: Math.ceil(total / filters.limit),
				hasNextPage: skip + items.length < total,
				hasPreviousPage: filters.page > 1
			}
		};
	}

	public async getPublicConversationById(session: SessionData, id: number) {
		const chat = await prismaService.wppChat.findFirst({
			where: { id, instance: session.instance },
			include: {
				contact: true,
				sector: true,
				_count: { select: { messages: true } }
			}
		});

		if (!chat) throw new NotFoundError("Conversation not found!");

		const [conversation] = await this.presentPublicConversations(session.instance, [chat]);
		return conversation;
	}

	/** Itens das rotas BI de conversa: cliente do ERP no contato e campo `report`. */
	private async presentPublicConversations<T extends WppChat & { contact: WppContact | null }>(
		instance: string,
		chats: T[]
	) {
		const customerIds = Array.from(
			new Set(
				chats
					.map((chat) => chat.contact?.customerId)
					.filter((id): id is number => typeof id === "number" && id > 0)
			)
		);
		const customers = customerIds.length
			? await instancesService.executeQuery<PublicCustomerRow[]>(instance, PUBLIC_CUSTOMERS_QUERY, [customerIds])
			: [];
		const customersById = new Map(
			customers.map((row) => [
				Number(row.CODIGO),
				{
					id: Number(row.CODIGO),
					name: row.RAZAO || null,
					cpfCnpj: row.CPF_CNPJ || null,
					erpCode: row.COD_ERP || null
				}
			])
		);
		const presented = chats.map((chat) => ({
			...chat,
			contact: chat.contact
				? { ...chat.contact, customer: customersById.get(chat.contact.customerId ?? 0) ?? null }
				: null
		}));

		return publicReportFieldsService.withConversationReport(instance, presented);
	}

	/**
	 * Chat com contato, cliente do CRM e histórico do contato. Sem escopo, busca em
	 * todos os tenants (rota interna chamada pelo ai-service antigo); com
	 * `withMessages: false`, não carrega o histórico (`messages: []`).
	 */
	public async getChatById(id: number, scope?: ChatScope, opts: { withMessages?: boolean } = {}) {
		const chat = await prismaService.wppChat.findFirst({
			where: {
				id,
				...(scope ? { instance: scope.instance } : {}),
				...(scope && scope.sectorId !== null && scope.sectorId !== undefined ? { sectorId: scope.sectorId } : {})
			},
			include: {
				contact: true
			}
		});

		if (!chat) {
			return null;
		}

		const rawMessages =
			opts.withMessages !== false && chat.contactId
				? await prismaService.wppMessage.findMany({
						where: { contactId: chat.contactId },
						orderBy: { timestamp: "asc" }
					})
				: [];

		const messages = rawMessages.length ? await messagePresentationService.hydrate(chat.instance, rawMessages) : [];
		if (chat.contact?.customerId) {
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

	/** Resposta do agente de IA (texto ou arquivo), gravada com agentId para não contar como resposta humana. */
	public async sendInternalAgentMessage(chatId: number, data: SendInternalAgentMessageData) {
		const chat = await prismaService.wppChat.findFirst({
			where: { id: chatId, ...(data.instance ? { instance: data.instance } : {}) },
			include: {
				contact: true,
				sector: true
			}
		});

		if (!chat) {
			throw new NotFoundError("Chat não encontrado.");
		}

		const contactAddress = chat.contact ? contactsService.resolveContactAddress(chat.contact) : null;

		if (!contactAddress) {
			throw new BadRequestError("Contato sem identificador WhatsApp para envio.");
		}

		if ((!data.text || !data.text.trim()) && !data.fileId) {
			throw new BadRequestError("É necessário informar texto ou fileId para enviar a mensagem do agente.");
		}

		const clientId = await this.resolveAgentClientId(chat, data.clientId);

		try {
			return await whatsappService.sendBotMessage(contactAddress, clientId, {
				chat,
				text: data.text ?? "",
				quotedId: data.quotedId ?? null,
				fileId: data.fileId ?? null,
				agentId: data.agentId ?? null
			});
		} catch (error) {
			throw withoutErrorCause(error);
		}
	}

	/**
	 * Canal das ações do agente: o informado; senão o último usado no chat; senão o
	 * padrão do setor. Recusa canal de outro tenant.
	 */
	private async resolveAgentClientId(chat: WppChat & { sector: WppSector | null }, providedClientId?: number | null) {
		let clientId =
			typeof providedClientId === "number" && Number.isInteger(providedClientId) && providedClientId > 0
				? providedClientId
				: null;

		if (clientId === null) {
			const latestChatMessage = await prismaService.wppMessage.findFirst({
				where: {
					chatId: chat.id,
					clientId: { not: null }
				},
				orderBy: [{ sentAt: "desc" }, { id: "desc" }],
				select: { clientId: true }
			});

			clientId = latestChatMessage?.clientId ?? null;
		}

		if (clientId === null) {
			clientId = chat.sector?.defaultClientId ?? null;
		}

		if (clientId === null) {
			Logger.error(`[agent-send] No clientId available to send agent message for chat ${chat.id}`);
			throw new BadRequestError("Não foi possível determinar o client do WhatsApp para este chat.");
		}

		const client = whatsappService.getClient(clientId);

		if (client && client.instance !== chat.instance) {
			throw new BadRequestError("O canal de WhatsApp informado não pertence a esta empresa.");
		}

		return clientId;
	}

	public async transferAttendance(token: string, session: SessionData, id: number, userId: number) {
		const { instance } = session;

		const usersService = getUsersClient();
		usersService.setAuth(token);

		const chats = await prismaService.wppChat.findFirst({
			where: { id, instance }
		});
		if (!chats) {
			throw new NotFoundError("Chat não encontrado.");
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
		await transferHistoryService.recordTransfer({
			previousChat: {
				id: chats.id,
				instance: chats.instance,
				userId: chats.userId,
				sectorId: chats.sectorId
			},
			nextChat: {
				id: chat.id,
				instance: chat.instance,
				userId: chat.userId,
				sectorId: chat.sectorId
			},
			source: "manual",
			initiatedByUserId: session.userId,
			reason: `Manual transfer from ${user.NOME} to user ${userId}`
		});

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
		reason?: string,
		options: { systemMessage?: string } = {}
	) {
		const logger = new ProcessingLogger(
			session.instance,
			"finish-chat",
			`chat_${id}_result_${resultId}_${Date.now()}`,
			{ chatId: id, resultId, userId: session.userId, reason }
		);

		try {
			logger.log(`Iniciando finalização do chat. Chat ID: ${id}, Resultado ID: ${resultId}`);

			const scopedChat = await prismaService.wppChat.findFirst({
				where: { id, instance: session.instance },
				select: { id: true }
			});

			if (!scopedChat) {
				logger.log(`Chat não encontrado na instância ${session.instance}. Chat ID: ${id}`);
				throw new NotFoundError("Chat não encontrado.");
			}

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

			const shouldTriggerSurvey = session.instance === "exatron" && result?.WHATS_ACAO === "trigger-survey";

			const { instance, userId } = session;
			const usersService = getUsersClient();
			usersService.setAuth(token || "");

			logger.log(`Buscando usuário que finalizou o atendimento. UserId: ${userId}`);
			// Sessões sintéticas (sistema e agente virtual) usam userId <= 0: não há usuário a buscar.
			const user = resultId !== -50 && userId > 0 ? await usersService.getUserById(userId) : null;
			if (user) {
				logger.log(`Usuário encontrado: ${user.NOME} (ID: ${user.CODIGO})`);
			} else {
				logger.log(`Chat finalizado pelo sistema (resultId: -50, sessão sem usuário ou usuário não encontrado)`);
			}

			if (shouldTriggerSurvey) {
				logger.log("Resultado configurado para pesquisa de satisfação. Não finalizando atendimento.");

				const chat = await prismaService.wppChat.findFirst({
					where: { id, instance },
					include: {
						contact: true
					}
				});

				if (!chat) {
					throw new Error(`Chat ${id} não encontrado para disparo da pesquisa`);
				}

				if (!chat.contact) {
					throw new Error(`Chat ${id} sem contato para disparo da pesquisa`);
				}

				const surveyChat = await prismaService.wppChat.update({
					where: { id: chat.id },
					data: {
						isFinished: false,
						finishedAt: null,
						finishedBy: null,
						resultId
					}
				});

				await this.syncChatToLocal(surveyChat);
				await messagesDistributionService.addSystemMessage(
					surveyChat,
					"Pesquisa de satisfação iniciada. O atendimento seguirá ativo durante a coleta das respostas."
				);

				logger.log(`Iniciando bot de satisfação. WHATS_ACAO: ${result?.WHATS_ACAO}`);
				const contactAddress = contactsService.resolveContactAddress(chat.contact);
				if (!contactAddress) {
					throw new Error(`Chat ${id} sem identificador de contato para disparo da pesquisa`);
				}
				await exatronSatisfactionBot.startBot(surveyChat, chat.contact, contactAddress);
				logger.success(`Pesquisa de satisfação disparada sem finalizar o chat. Chat ID: ${chat.id}`);
				return;
			}

			logger.log(`Atualizando chat no banco de dados. Marcando como finalizado`);
			const finishedAt = new Date();
			const updateResult = await prismaService.wppChat.updateMany({
				where: {
					id,
					instance,
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

			let finishMsg: string;

			if (user) {
				finishMsg = `Atendimento finalizado por ${user.NOME}.\nResultado: ${results[0]?.NOME || "N/D"} `;
				logger.log(`Mensagem do usuário: "${finishMsg}"`);
			} else {
				finishMsg =
					options.systemMessage ??
					buildSystemFinishMessage(resultId !== -50 ? (result?.NOME ?? null) : null, reason);
				logger.log(`Mensagem do sistema: "${finishMsg}"`);
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

			logger.log(
				`Bot de satisfação não será acionado. Instance: ${chat.instance}, WHATS_ACAO: ${result?.WHATS_ACAO}`
			);

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

			if (lastCampaign.CONCLUIDO == "NAO") {
				logger.log(`Atualizando campanha para cliente ${customer.CODIGO}. Novo operador: ${chat.userId}.`);

				const params: Array<any> = [chat.userId];
				let updateQuery = `UPDATE campanhas_clientes SET OPERADOR = ?, FIDELIZA = 'S'`;

				if (newScheduleDate instanceof Date) {
					logger.log(
						`Nova data de agendamento calculada: ${newScheduleDate.toISOString()}. Atualizando campanha com nova data.`
					);
					updateQuery = updateQuery + `, DT_AGENDAMENTO = ?`;
					params.push(formatDateForMySQL(newScheduleDate));
				}

				updateQuery = updateQuery + ` WHERE CODIGO = ?`;
				params.push(lastCampaign.CODIGO);

				await instancesService.executeQuery(chat.instance, updateQuery, params);
				logger.log(`Campanha atualizada com sucesso`);
			} else {
				const thirtyDaysLater = new Date();
				thirtyDaysLater.setDate(thirtyDaysLater.getDate() + 30);

				const insertQueryKeys = {
					CLIENTE: contact.customerId,
					CAMPANHA: lastCampaign.CAMPANHA,
					AGENDA: 0,
					DT_AGENDAMENTO: formatDateForMySQL(newScheduleDate || thirtyDaysLater),
					CONCLUIDO: "NAO",
					FONE1: lastCampaign.FONE1,
					FONE2: lastCampaign.FONE2,
					FONE3: lastCampaign.FONE3,
					ORDEM: lastCampaign.ORDEM,
					FIDELIZA: "S",
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
				logger.log(
					`Aviso: Campanha não encontrada para código ${lastIS.CAMPANHA}. Pulando criação de histórico.`
				);
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

			const contactAddress = contactsService.resolveContactAddress(contact);
			const profilePicture = contactAddress
				? await whatsappService.getProfilePictureUrl(session.instance, contactAddress)
				: null;

			let userId = session.userId;
			const params = await parametersService.getSessionParams(session);

			if (params["start_chats_as_admin"] === "true") {
				userId = -1;
			}

			const newChat = await prismaService.wppChat.create({
				data: {
					instance: session.instance,
					type: "ACTIVE",
					avatarUrl: profilePicture,
					userId,
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
				const templateTarget = contactsService.resolveContactAddress(newChat.contact);
				if (!templateTarget) {
					throw new BadRequestError("Contato sem identificador WhatsApp para envio do template.");
				}
				await whatsappService.sendTemplate(
					session,
					client.id,
					templateTarget,
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

	public async systemStartNewChat({
		instance,
		sectorId,
		userId,
		agentId,
		contact,
		systemMessage
	}: SystemStartNewChatProps) {
		const process = new ProcessingLogger(instance, "system-start-chat", `system-${contact.id}-${Date.now()}`, {
			instance,
			contactId: contact.id
		});

		try {
			process.log(`Starting chat for contact ID ${contact.id} in instance ${instance}`);
			process.log("Checking if chat already exists...");
			await this.checkIfChatExistsOrThrow(instance, contact.id);
			process.log("No existing chat found, proceeding to create a new chat...");

			const contactAddress = contactsService.resolveContactAddress(contact);
			const profilePicture = contactAddress
				? await whatsappService.getProfilePictureUrl(instance, contactAddress)
				: null;
			const newChat = await prismaService.wppChat.create({
				data: {
					instance,
					type: "ACTIVE",
					avatarUrl: profilePicture,
					userId: userId ?? null,
					agentId: agentId ?? null,
					contactId: contact.id,
					sectorId: sectorId ?? null,
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

	public async ensureActiveChatForAgent({
		instance,
		contactId,
		agentId,
		systemMessage,
		sectorId,
		userId
	}: EnsureActiveChatForAgentProps) {
		const existingChat = await prismaService.wppChat.findFirst({
			where: {
				instance,
				contactId,
				isFinished: false
			}
		});

		if (existingChat) {
			return { chat: existingChat, existed: true };
		}

		const contact = await prismaService.wppContact.findFirst({
			where: {
				id: contactId,
				instance,
				isDeleted: false
			},
			include: { sectors: true } as any
		});

		if (!contact) {
			throw new BadRequestError("Contato não encontrado.");
		}

		const inferredSectorId =
			typeof sectorId === "number"
				? sectorId
				: (((contact as any).sectors?.[0]?.sectorId as number | undefined) ?? null);

		const newChat = await this.systemStartNewChat({
			instance,
			contact,
			sectorId: inferredSectorId,
			userId: userId ?? null,
			agentId: agentId ?? null,
			...(systemMessage !== undefined ? { systemMessage } : {})
		});

		return { chat: newChat, existed: false };
	}

	/**
	 * Transferência pedida pelo agente de IA, sem token de usuário: atribui o operador
	 * (mesmo em chat sem dono), tira o agente e o robô do chat e avisa as telas.
	 */
	public async transferChatByAgent(chatId: number, input: AgentTransferInput) {
		const { instance, agentId, userId } = input;
		const logger = new ProcessingLogger(instance, "agent-transfer", `chat_${chatId}_agent_${agentId}_${Date.now()}`, {
			chatId,
			agentId,
			userId
		});

		try {
			const previousChat = await prismaService.wppChat.findFirst({
				where: { id: chatId, instance, isFinished: false }
			});

			if (!previousChat) {
				throw new NotFoundError("Chat não encontrado ou já finalizado.");
			}

			const userName = await this.findOperatorName(instance, userId, logger);

			const updateResult = await prismaService.wppChat.updateMany({
				where: { id: chatId, instance, isFinished: false },
				data: { userId, agentId: null, botId: null }
			});

			if (updateResult.count === 0) {
				throw new NotFoundError("Chat não encontrado ou já finalizado.");
			}

			const chat = await prismaService.wppChat.findUniqueOrThrow({ where: { id: chatId } });
			logger.log(`Chat ${chat.id} atribuído ao operador ${userId} (antes: ${previousChat.userId ?? "sem dono"}).`);

			// A transferência já foi gravada: falhas daqui em diante só são registradas,
			// para o ai-service não tratar como transferência que não aconteceu.
			await this.runAfterAgentAction(logger, "sincronizar o chat no CRM", () => this.syncChatToLocal(chat));
			await transferHistoryService.recordTransfer({
				previousChat: {
					id: previousChat.id,
					instance: previousChat.instance,
					userId: previousChat.userId,
					sectorId: previousChat.sectorId
				},
				nextChat: {
					id: chat.id,
					instance: chat.instance,
					userId: chat.userId,
					sectorId: chat.sectorId
				},
				source: "ai-agent",
				initiatedByUserId: null,
				reason: buildAgentTransferHistoryReason(agentId, input.reason)
			});
			await this.runAfterAgentAction(logger, "gravar a mensagem de sistema", () =>
				messagesDistributionService.addSystemMessage(
					chat,
					buildAgentTransferMessage(input.agentName, agentId, userName, userId)
				)
			);
			await this.runAfterAgentAction(logger, "avisar as telas", async () => {
				await socketService.emit(SocketEventType.WppChatTransfer, `${instance}:chat:${chat.id}`, {
					chatId: chat.id
				});

				if (chat.sectorId !== null) {
					const monitorRoom: SocketServerMonitorRoom = `${instance}:${chat.sectorId}:monitor`;
					await socketService.emit(SocketEventType.WppChatStarted, monitorRoom, { chatId: chat.id });
				}

				const userRoom: SocketServerUserRoom = `${instance}:user:${userId}`;
				await socketService.emit(SocketEventType.WppChatStarted, userRoom, { chatId: chat.id });
			});

			const data = { chatId: chat.id, userId, userName };
			logger.success(data);

			return data;
		} catch (err) {
			logger.failed(err);
			throw err;
		}
	}

	/** Encerramento pedido pelo agente de IA, sem token de usuário (resultado padrão −50). */
	public async finishChatByAgent(chatId: number, input: AgentFinishInput) {
		const { instance, agentId } = input;
		const chat = await prismaService.wppChat.findFirst({
			where: { id: chatId, instance },
			select: { id: true, sectorId: true }
		});

		if (!chat) {
			throw new NotFoundError("Chat não encontrado.");
		}

		await this.finishChatById(
			null,
			buildSyntheticSession(instance, chat.sectorId),
			chat.id,
			input.resultId ?? -50,
			null,
			input.reason ?? undefined,
			{ systemMessage: buildAgentFinishMessage(input.agentName, agentId, input.reason) }
		);
	}

	/** Template disparado pelo agente de IA; a mensagem fica com agentId (não conta como resposta humana). */
	public async sendTemplateByAgent(chatId: number, input: AgentSendTemplateInput) {
		const { instance, agentId } = input;
		const chat = await prismaService.wppChat.findFirst({
			where: { id: chatId, instance, isFinished: false },
			include: { contact: true, sector: true }
		});

		if (!chat) {
			throw new NotFoundError("Chat não encontrado ou já finalizado.");
		}

		const contactAddress = chat.contact ? contactsService.resolveContactAddress(chat.contact) : null;

		if (!chat.contact || !contactAddress) {
			throw new BadRequestError("Contato sem identificador WhatsApp para envio.");
		}

		const clientId = await this.resolveAgentClientId(chat, input.clientId);

		if (!whatsappService.getClient(clientId)) {
			throw new BadRequestError("Client do WhatsApp não encontrado.");
		}

		if (!whatsappService.clientSupportsTemplates(clientId)) {
			throw new BadRequestError("Este canal não oferece templates.");
		}

		let templates: TemplateMessage[];

		try {
			templates = await whatsappService.getTemplates(clientId);
		} catch (error) {
			Logger.error(
				`[agent-send-template] Falha ao listar templates | instance=${instance} | clientId=${clientId}: ${sanitizeErrorMessage(error)}`
			);
			throw new BadRequestError("Não foi possível consultar os templates deste canal agora. Tente novamente em instantes.");
		}

		const templateName = input.templateName.trim();
		const templateLanguage = input.templateLanguage?.trim() || null;
		const template = (Array.isArray(templates) ? templates : []).find(
			(item) => item.name === templateName && (!templateLanguage || item.language === templateLanguage)
		);

		if (!template) {
			throw new NotFoundError(
				`Template “${templateName}”${templateLanguage ? ` (${templateLanguage})` : ""} não encontrado neste canal.`
			);
		}

		try {
			await whatsappService.sendTemplate(
				buildSyntheticSession(instance, chat.sectorId),
				clientId,
				contactAddress,
				{ template, templateVariables: input.templateVariables, components: input.components },
				chat.id,
				chat.contact.id,
				{ agentId }
			);
		} catch (error) {
			throw withoutErrorCause(error);
		}
	}

	/** Nome do operador no CRM do tenant; falha de consulta não impede a transferência (fica o código). */
	private async findOperatorName(instance: string, userId: number, logger: ProcessingLogger) {
		let rows: Array<{ NOME?: unknown }>;

		try {
			rows = await instancesService.executeQuery<Array<{ NOME?: unknown }>>(instance, FETCH_OPERATOR_NAME_QUERY, [
				userId
			]);
		} catch (error) {
			logger.log(`Nome do operador ${userId} indisponível (CRM): ${sanitizeErrorMessage(error)}`);
			return null;
		}

		if (!Array.isArray(rows)) {
			logger.log(`Resposta inesperada do CRM ao buscar o operador ${userId}; seguindo com o código.`);
			return null;
		}

		// Consulta respondida sem linha: o operador não existe neste tenant e o chat ficaria sem dono visível.
		if (rows.length === 0) {
			throw new BadRequestError(`Operador #${userId} não encontrado nesta empresa.`);
		}

		const name = rows[0]?.NOME;

		return typeof name === "string" && name.trim() ? name.trim() : null;
	}

	private async runAfterAgentAction(logger: ProcessingLogger, step: string, action: () => Promise<unknown>) {
		try {
			await action();
		} catch (error) {
			logger.log(`Falha ao ${step} depois da ação do agente: ${sanitizeErrorMessage(error)}`);
			Logger.error(`[agent-action] Falha ao ${step}: ${sanitizeErrorMessage(error)}`);
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
