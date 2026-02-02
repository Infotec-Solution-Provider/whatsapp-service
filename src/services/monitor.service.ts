import { SessionData } from "@in.pulse-crm/sdk";
import { WppMessage } from "@prisma/client";
import chatsService from "./chats.service";
import internalChatsService from "./internal-chats.service";
import schedulesService from "./schedules.service";
import instancesService from "./instances.service";
import prismaService from "./prisma.service";
import { safeDecode } from "../utils/safe-encode";

interface MonitorSearchInput {
	page?: number;
	pageSize?: number;
	filters?: Record<string, any>;
}

class MonitorService {

	public async getMonitorData(session: SessionData) {
		const schedules = await schedulesService.getSchedulesBySession(session, {});
		const { chats: whatsappChats } = await chatsService.getChatsMonitor(session, true, true);
		const { chats: internalChats } = await internalChatsService.getInternalChatsMonitor(session);

		return {
			schedules,
			whatsappChats,
			internalChats
		};
	}

	public async searchMonitorData(session: SessionData, input: MonitorSearchInput) {
		return this.searchMonitorDataInternalStandard(session, input);
	}

	public async searchMonitorDataLocal(session: SessionData, input: MonitorSearchInput) {
		return this.searchMonitorDataInternalLocal(session, input);
	}

	private async searchMonitorDataInternalStandard(session: SessionData, input: MonitorSearchInput) {
		const page = Number(input.page) || 1;
		const pageSize = Number(input.pageSize) || 20;
		const filters = (input.filters as Record<string, any>) || {};

		const schedules = await schedulesService.getSchedulesBySession(session, {});
		const whatsappChatsRaw = (await chatsService.getChatsMonitor(session, false, true)).chats;
		const { chats: internalChatsRaw } = await internalChatsService.getInternalChatsMonitor(session);

		const contactIds = whatsappChatsRaw
			.map((chat: any) => chat?.contactId)
			.filter((id: any): id is number => typeof id === "number");

		if (contactIds.length) {
			const lastMessages = await prismaService.wppMessage.findMany({
				where: {
					instance: session.instance,
					contactId: { in: contactIds }
				},
				orderBy: { sentAt: "desc" },
				distinct: ["contactId"]
			});

			const unreadCounts = await prismaService.wppMessage.groupBy({
				by: ["contactId"],
				where: {
					instance: session.instance,
					contactId: { in: contactIds },
					status: { not: "READ" },
					NOT: [
						{ from: { startsWith: "me:" } },
						{ from: { startsWith: "system:" } },
						{ from: { startsWith: "bot" } },
						{ from: { startsWith: "thirdparty" } },
						{ from: { startsWith: "user:" } }
					]
				},
				_count: { _all: true }
			});

			const lastMessageByContact = new Map<number, WppMessage>();
			lastMessages.forEach((msg) => {
				if (typeof msg.contactId === "number") {
					lastMessageByContact.set(msg.contactId, msg);
				}
			});

			const unreadByContact = new Map<number, number>();
			unreadCounts.forEach((row) => {
				if (typeof row.contactId === "number") {
					unreadByContact.set(row.contactId, row._count._all || 0);
				}
			});

			whatsappChatsRaw.forEach((chat: any) => {
				const contactId = chat?.contactId;
				if (typeof contactId !== "number") return;
				chat.lastMessage = lastMessageByContact.get(contactId) || null;
				chat.isUnread = (unreadByContact.get(contactId) || 0) > 0;
			});
		}

		return this.applyMonitorFiltersAndPagination(
			{ page, pageSize, filters },
			whatsappChatsRaw,
			internalChatsRaw,
			schedules,
			false
		);
	}

	private async searchMonitorDataInternalLocal(session: SessionData, input: MonitorSearchInput) {
		const page = Number(input.page) || 1;
		const pageSize = Number(input.pageSize) || 20;
		const filters = (input.filters as Record<string, any>) || {};
		const searchText = String(filters["searchText"] || "").trim();
		const searchColumn = String(filters["searchColumn"] || "all");

		const needsLastMessage =
			!!searchText && (searchColumn === "message" || searchColumn === "all")
				? true
				: filters["showPendingResponseOnly"] || filters["sortBy"] === "lastMessage";
		const needsUnread = !!filters["showUnreadOnly"];

		const schedules = await this.getLocalSchedules(session, filters);
		const whatsappChatsRaw = await this.getLocalWhatsappChats(session, {
			includeLastMessage: needsLastMessage,
			includeUnread: needsUnread,
			filters
		});
		const { chats: internalChatsRaw } = await internalChatsService.getInternalChatsMonitor(session);

		return this.applyMonitorFiltersAndPagination(
			{ page, pageSize, filters },
			whatsappChatsRaw,
			internalChatsRaw,
			schedules,
			true
		);
	}

	private applyMonitorFiltersAndPagination(
		input: { page: number; pageSize: number; filters: Record<string, any> },
		whatsappChatsRaw: any[],
		internalChatsRaw: any[],
		schedules: any[],
		isLocal: boolean
	) {
		const { page, pageSize, filters } = input;

		const whatsappChats = whatsappChatsRaw.map((chat: any) => {
			const messages = chat?.messages || chat?.contact?.WppMessage || [];
			const lastMessage =
				chat?.lastMessage ||
				messages.reduce((prev: any, curr: any) => {
					if (!prev) return curr;
					return (curr?.timestamp || 0) > (prev?.timestamp || 0) ? curr : prev;
				}, null);

			const isUnread =
				typeof chat?.isUnread === "boolean"
					? chat.isUnread
					: messages.some((m: any) => {
						const from = String(m.from || "");
						const isFromUs =
							from.startsWith("me:") ||
							from.startsWith("system:") ||
							from.startsWith("bot") ||
							from.startsWith("thirdparty") ||
							from.startsWith("user:");
						return m.status !== "READ" && !isFromUs;
					});

			return {
				...chat,
				messages,
				chatType: "wpp",
				lastMessage,
				isUnread
			};
		});

		const internalChats = internalChatsRaw.map((chat: any) => {
			const messages = chat.messages || [];
			const lastMessage = messages.reduce((prev: any, curr: any) => {
				if (!prev) return curr;
				return (curr?.timestamp || 0) > (prev?.timestamp || 0) ? curr : prev;
			}, null);
			const isUnread = messages.some((m: any) => m.status !== "READ");

			return {
				...chat,
				chatType: "internal",
				lastMessage,
				isUnread
			};
		});

		const normalizedFilters = {
			searchText: filters["searchText"] || "",
			categories: {
				showCustomerChats: filters["categories"]?.showCustomerChats ?? true,
				showInternalChats: filters["categories"]?.showInternalChats ?? true,
				showInternalGroups: filters["categories"]?.showInternalGroups ?? true,
				showSchedules: filters["categories"]?.showSchedules ?? true
			},
			user: filters["user"] ?? "all",
			showBots: !!filters["showBots"],
			showOngoing: filters["showOngoing"] ?? true,
			showFinished: filters["showFinished"] ?? true,
			showOnlyScheduled: !!filters["showOnlyScheduled"],
			showUnreadOnly: !!filters["showUnreadOnly"],
			showPendingResponseOnly: !!filters["showPendingResponseOnly"],
			sortBy: filters["sortBy"] || "startedAt",
			sortOrder: filters["sortOrder"] || "desc",
			startedAt: filters["startedAt"] || { from: null, to: null },
			finishedAt: filters["finishedAt"] || { from: null, to: null },
			scheduledAt: filters["scheduledAt"] || { from: null, to: null },
			scheduledTo: filters["scheduledTo"] || { from: null, to: null },
			scheduledBy: filters["scheduledBy"] ?? "all",
			scheduledFor: filters["scheduledFor"] ?? "all"
		};

		const normalize = (s?: string | null) =>
			(s ?? "")
				.toString()
				.normalize("NFD")
				.replace(/[\u0300-\u036f]/g, "")
				.toLowerCase();

		const onlyDigits = (s?: string | null) => (s ?? "").toString().replace(/\D/g, "");

		const search = normalize(normalizedFilters.searchText);
		const searchColumn = isLocal ? String(filters["searchColumn"] || "all") : "all";

		const matchesSearch = (values: Array<string | null | undefined>) => {
			if (!search) return true;
			const joined = values.filter(Boolean).map(String);
			const haystack = normalize(joined.join(" "));
			if (haystack.includes(search)) return true;

			const searchDigits = onlyDigits(normalizedFilters.searchText);
			if (searchDigits.length >= 3) {
				return values.some((v) => onlyDigits(v).includes(searchDigits));
			}

			return false;
		};

		const pickCandidates = (groups: {
			name?: Array<string | null | undefined>;
			phone?: Array<string | null | undefined>;
			customer?: Array<string | null | undefined>;
			message?: Array<string | null | undefined>;
		}) => {
			const name = groups.name || [];
			const phone = groups.phone || [];
			const customer = groups.customer || [];
			const message = groups.message || [];

			switch (searchColumn) {
				case "name":
					return name;
				case "phone":
					return phone;
				case "customer":
					return customer;
				case "message":
					return message;
				default:
					return [...name, ...phone, ...customer, ...message];
			}
		};

		const filteredInternal = internalChats.filter((chat: any) => {
			if (chat.isGroup && !normalizedFilters.categories.showInternalGroups) return false;
			if (!chat.isGroup && !normalizedFilters.categories.showInternalChats) return false;
			if (
				normalizedFilters.user !== "all" &&
				!chat.participants?.some((p: any) => p.userId === normalizedFilters.user)
			) {
				return false;
			}
			if (normalizedFilters.showOnlyScheduled) return false;

			const chatStartedAt = chat.startedAt ? new Date(chat.startedAt) : null;
			if (
				normalizedFilters.startedAt?.from &&
				chatStartedAt &&
				chatStartedAt < new Date(normalizedFilters.startedAt.from)
			) {
				return false;
			}
			if (
				normalizedFilters.startedAt?.to &&
				chatStartedAt &&
				chatStartedAt > new Date(normalizedFilters.startedAt.to)
			) {
				return false;
			}

			const anyChat: any = chat;
			const nameCandidates: Array<string | null | undefined> = [
				anyChat?.name,
				anyChat?.title,
				anyChat?.groupName
			];
			if (Array.isArray(anyChat?.participants)) {
				nameCandidates.push(
					...anyChat.participants
						.map((p: any) => p.name || p.NOME || p?.user?.name)
						.filter(Boolean)
				);
			}
			const lastMessageCandidates: Array<string | null | undefined> = [
				anyChat?.lastMessageBody,
				anyChat?.lastMessage?.body,
				anyChat?.lastMessageText,
				anyChat?.lastMsg?.body,
				anyChat?.messages?.[anyChat?.messages?.length - 1]?.body,
				anyChat?.messages?.[0]?.body
			];

			return matchesSearch(
				pickCandidates({
					name: nameCandidates,
					message: lastMessageCandidates
				})
			);
		});

		const filteredWpp = whatsappChats.filter((chat: any) => {
			if (!normalizedFilters.categories.showCustomerChats) return false;
			if (normalizedFilters.user !== "all" && chat.userId !== normalizedFilters.user) return false;
			if (!normalizedFilters.showBots && chat.botId !== null) return false;
			if (normalizedFilters.showOnlyScheduled && !chat.isSchedule) return false;
			if (
				normalizedFilters.scheduledFor !== "all" &&
				"schedule" in chat &&
				chat.schedule?.scheduledFor !== normalizedFilters.scheduledFor
			) {
				return false;
			}

			const isOngoing = chat.finishedAt === null && chat.startedAt !== null;
			const isFinished = chat.finishedAt !== null;

			if (!normalizedFilters.showOngoing && !normalizedFilters.showFinished) return false;
			if (normalizedFilters.showOngoing && !normalizedFilters.showFinished && !isOngoing) return false;
			if (!normalizedFilters.showOngoing && normalizedFilters.showFinished && !isFinished) return false;

			if (normalizedFilters.showUnreadOnly && !chat.isUnread) return false;

			if (normalizedFilters.showPendingResponseOnly) {
				const lastMsg = chat.lastMessage || chat.lastMsg;
				if (!lastMsg) return false;
				const from = String(lastMsg.from || "");
				const isFromAgent = from.startsWith("me:") || from.startsWith("user:");
				if (isFromAgent) return false;
			}

			const chatStartedAt = chat.startedAt ? new Date(chat.startedAt) : null;
			if (
				normalizedFilters.startedAt?.from &&
				chatStartedAt &&
				chatStartedAt < new Date(normalizedFilters.startedAt.from)
			)
				return false;
			if (
				normalizedFilters.startedAt?.to &&
				chatStartedAt &&
				chatStartedAt > new Date(normalizedFilters.startedAt.to)
			)
				return false;

			if (chat.finishedAt) {
				const chatFinishedAt = new Date(chat.finishedAt);
				if (
					normalizedFilters.finishedAt?.from &&
					chatFinishedAt < new Date(normalizedFilters.finishedAt.from)
				)
					return false;
				if (
					normalizedFilters.finishedAt?.to &&
					chatFinishedAt > new Date(normalizedFilters.finishedAt.to)
				)
					return false;
			}

			const nameCandidates: Array<string | null | undefined> = [
				chat?.contact?.name
			];
			const phoneCandidates: Array<string | null | undefined> = [
				chat?.contact?.phone,
				chat?.contact?.phoneNumber,
				chat?.contact?.phone_number,
				chat?.contact?.formattedPhone,
				chat?.contact?.formattedPhoneNumber,
				chat?.contact?.phoneFormatted,
				chat?.contact?.shortPhone
			];
			const customerCandidates: Array<string | null | undefined> = [
				chat?.customer?.RAZAO
			];
			const lastMessageCandidates: Array<string | null | undefined> = [
				chat?.lastMessageBody,
				chat?.lastMessage?.body,
				chat?.lastMessageText,
				chat?.lastMsg?.body,
				chat?.messages?.[chat?.messages?.length - 1]?.body,
				chat?.messages?.[0]?.body
			];

			return matchesSearch(
				pickCandidates({
					name: nameCandidates,
					phone: phoneCandidates,
					customer: customerCandidates,
					message: lastMessageCandidates
				})
			);
		});

		const filteredSchedules = schedules.filter((schedule: any) => {
			if (!normalizedFilters.categories.showSchedules) return false;
			if (
				normalizedFilters.scheduledFor !== "all" &&
				schedule.scheduledFor !== normalizedFilters.scheduledFor
			)
				return false;
			if (
				normalizedFilters.scheduledBy !== "all" &&
				schedule.scheduledBy !== normalizedFilters.scheduledBy
			)
				return false;

			const scheduledAt = schedule.scheduledAt ? new Date(schedule.scheduledAt) : null;
			if (
				normalizedFilters.scheduledAt?.from &&
				scheduledAt &&
				scheduledAt < new Date(normalizedFilters.scheduledAt.from)
			)
				return false;
			if (
				normalizedFilters.scheduledAt?.to &&
				scheduledAt &&
				scheduledAt > new Date(normalizedFilters.scheduledAt.to)
			)
				return false;
			
			const scheduledTo = schedule.scheduleDate ? new Date(schedule.scheduleDate) : null;
			if (
				normalizedFilters.scheduledTo?.from &&
				scheduledTo &&
				scheduledTo < new Date(normalizedFilters.scheduledTo.from)
			)
				return false;
			if (
				normalizedFilters.scheduledTo?.to &&
				scheduledTo &&
				scheduledTo > new Date(normalizedFilters.scheduledTo.to)
			)
				return false;

			return matchesSearch(
				pickCandidates({
					name: [schedule?.contact?.name],
					phone: [
						schedule?.contact?.phone,
						schedule?.contact?.phoneNumber,
						schedule?.contact?.phone_number,
						schedule?.contact?.formattedPhone,
						schedule?.contact?.formattedPhoneNumber,
						schedule?.contact?.phoneFormatted
					],
					customer: [schedule?.customer?.RAZAO, schedule?.customer?.CPF_CNPJ]
				})
			);
		});

		const allItems = [...filteredInternal, ...filteredWpp, ...filteredSchedules];

		const sortedItems = allItems.sort((a: any, b: any) => {
			const sortBy = normalizedFilters.sortBy;
			const sortOrder = normalizedFilters.sortOrder === "asc" ? 1 : -1;

			const getValue = (item: any) => {
				switch (sortBy) {
					case "finishedAt":
						return item.finishedAt ? new Date(item.finishedAt).getTime() : 0;
					case "lastMessage":
						return item.lastMessage?.timestamp || item.lastMsg?.timestamp || 0;
					case "scheduledAt":
						if (item.schedule?.scheduledAt) return new Date(item.schedule.scheduledAt).getTime();
						if (item.scheduleDate) return new Date(item.scheduleDate).getTime();
						if (item.scheduledAt) return new Date(item.scheduledAt).getTime();
						return 0;
					case "name":
						return normalize(item?.contact?.name || item?.groupName || item?.name || "");
					default:
						return item.startedAt ? new Date(item.startedAt).getTime() : 0;
				}
			};

			const aVal = getValue(a);
			const bVal = getValue(b);

			if (typeof aVal === "string" && typeof bVal === "string") {
				return aVal.localeCompare(bVal) * sortOrder;
			}

			return (aVal > bVal ? 1 : -1) * sortOrder;
		});

		const totalCount = sortedItems.length;
		const start = (page - 1) * pageSize;
		const end = start + pageSize;
		const items = sortedItems.slice(start, end);

		return {
			items,
			totalCount
		};
	}

	private async getLocalWhatsappChats(
		session: SessionData,
		options: { includeLastMessage?: boolean; includeUnread?: boolean; filters?: Record<string, any> } = {}
	) {
		const isTI = session.sectorId === 3 || session.instance !== "nunes";
		const params: any[] = [session.instance];
		let whereClause = "chat.instance = ?";

		if (!isTI) {
			whereClause += " AND chat.sector_id = ?";
			params.push(session.sectorId);
		}

		const filters = options.filters || {};

		// Filtros de estado do chat
		const showOngoing = filters["showOngoing"] ?? true;
		const showFinished = filters["showFinished"] ?? true;
		if (!showOngoing && showFinished) {
			whereClause += " AND chat.is_finished = 1";
		} else if (showOngoing && !showFinished) {
			whereClause += " AND chat.is_finished = 0";
		}

		// Filtro de usuário
		if (filters["user"] && filters["user"] !== "all") {
			whereClause += " AND chat.user_id = ?";
			params.push(filters["user"]);
		}

		// Filtro de bots
		if (!filters["showBots"]) {
			whereClause += " AND (chat.bot_id IS NULL OR chat.bot_id = 0)";
		}

		// Filtro de agendados
		if (filters["showOnlyScheduled"]) {
			whereClause += " AND chat.is_schedule = 1";
		}

		// Filtro de data de início
		if (filters["startedAt"]?.from) {
			whereClause += " AND chat.started_at >= ?";
			params.push(new Date(filters["startedAt"].from));
		}
		if (filters["startedAt"]?.to) {
			whereClause += " AND chat.started_at <= ?";
			params.push(new Date(filters["startedAt"].to));
		}

		// Filtro de data de finalização
		if (filters["finishedAt"]?.from) {
			whereClause += " AND chat.finished_at >= ?";
			params.push(new Date(filters["finishedAt"].from));
		}
		if (filters["finishedAt"]?.to) {
			whereClause += " AND chat.finished_at <= ?";
			params.push(new Date(filters["finishedAt"].to));
		}

		// Filtro de scheduledFor (requer JOIN com schedules)
		if (filters["scheduledFor"] && filters["scheduledFor"] !== "all") {
			whereClause += " AND sch.scheduled_for = ?";
			params.push(filters["scheduledFor"]);
		}

		const includeLastMessage = options.includeLastMessage !== false;
		const includeUnread = options.includeUnread !== false;

		// Filtro de texto (busca)
		const searchText = String(filters["searchText"] || "").trim();
		const searchColumn = String(filters["searchColumn"] || "all");
		if (searchText) {
			const searchPattern = `%${searchText}%`;
			const conditions: string[] = [];

			if (searchColumn === "name" || searchColumn === "all") {
				conditions.push("ctt.name LIKE ?");
				params.push(searchPattern);
			}
			if (searchColumn === "phone" || searchColumn === "all") {
				conditions.push("ctt.phone LIKE ?");
				params.push(searchPattern);
			}
			if (searchColumn === "customer" || searchColumn === "all") {
				conditions.push("cli.RAZAO LIKE ?");
				params.push(searchPattern);
			}
			if (searchColumn === "message" || searchColumn === "all") {
				if (includeLastMessage) {
					conditions.push("lm.body LIKE ?");
					params.push(searchPattern);
				}
			}

			if (conditions.length > 0) {
				whereClause += " AND (" + conditions.join(" OR ") + ")";
			}
		}

		// Filtro de showUnreadOnly
		if (filters["showUnreadOnly"] && includeUnread) {
			whereClause += " AND unread.unread_count > 0";
		}

		// Filtro de showPendingResponseOnly
		if (filters["showPendingResponseOnly"] && includeLastMessage) {
			whereClause += " AND lm.`from` NOT LIKE 'me:%' AND lm.`from` NOT LIKE 'user:%'";
		}

		// Construir SELECT com campos condicionais
		const lastMessageFields = includeLastMessage
			? `,
				lm.message_id as lm_message_id,
				lm.chat_id as lm_chat_id,
				lm.from as lm_from,
				lm.to as lm_to,
				lm.type as lm_type,
				lm.body as lm_body,
				lm.timestamp as lm_timestamp,
				lm.sent_at as lm_sent_at,
				lm.status as lm_status,
				lm.file_id as lm_file_id,
				lm.file_name as lm_file_name,
				lm.file_type as lm_file_type,
				lm.file_size as lm_file_size,
				lm.user_id as lm_user_id,
				lm.billing_category as lm_billing_category,
				lm.client_id as lm_client_id`
			: "";

		const unreadField = includeUnread
			? `,
				COALESCE(unread.unread_count, 0) as unread_count`
			: "";

		// JOIN com schedules para filtro scheduledFor
		const schedulesJoin = filters["scheduledFor"] && filters["scheduledFor"] !== "all"
			? `LEFT JOIN wpp_schedules sch ON sch.instance = chat.instance AND sch.chat_id = chat.original_id`
			: "";

		// Construir JOINs condicionais
		const lastMessageJoin = includeLastMessage
			? `LEFT JOIN wpp_last_messages lm ON lm.instance = chat.instance AND lm.contact_id = chat.contact_id`
			: "";

		const unreadJoin = includeUnread
			? `LEFT JOIN (
					SELECT contact_id,
						SUM(
							CASE
								WHEN status <> 'READ'
								AND \`from\` NOT LIKE 'me:%'
								AND \`from\` NOT LIKE 'system:%'
								AND \`from\` NOT LIKE 'bot%'
								AND \`from\` NOT LIKE 'thirdparty%'
								AND \`from\` NOT LIKE 'user:%'
								THEN 1 ELSE 0
							END
						) AS unread_count
					FROM wpp_messages
					WHERE instance = ?
					GROUP BY contact_id
				) unread ON unread.contact_id = chat.contact_id`
			: "";

		// Adicionar parâmetro extra para unread subquery se necessário
		if (includeUnread) {
			params.push(session.instance);
		}

		// Ordenação
		const sortBy = filters["sortBy"] || "startedAt";
		const sortOrder = (filters["sortOrder"] || "desc").toUpperCase();
		let orderClause = "";
		switch (sortBy) {
			case "finishedAt":
				orderClause = `ORDER BY chat.finished_at ${sortOrder}`;
				break;
			case "lastMessage":
				if (includeLastMessage) {
					orderClause = `ORDER BY lm.timestamp ${sortOrder}`;
				} else {
					orderClause = `ORDER BY chat.started_at ${sortOrder}`;
				}
				break;
			case "name":
				orderClause = `ORDER BY ctt.name ${sortOrder}`;
				break;
			default:
				orderClause = `ORDER BY chat.started_at ${sortOrder}`;
		}

		const query = `
			SELECT
				chat.original_id as id,
				chat.instance,
				chat.type,
				chat.avatar_url,
				chat.user_id,
				chat.contact_id,
				chat.sector_id,
				chat.started_at,
				chat.finished_at,
				chat.finished_by,
				chat.result_id,
				chat.is_finished,
				chat.is_schedule,
				ctt.id as contact_id,
				ctt.name as contact_name,
				ctt.phone as contact_phone,
				ctt.customer_id as contact_customer_id,
				cli.CODIGO as customer_CODIGO,
				cli.RAZAO as customer_RAZAO,
				cli.FANTASIA as customer_FANTASIA,
				cli.CPF_CNPJ as customer_CPF_CNPJ,
				cli.COD_ERP as customer_COD_ERP
				${lastMessageFields}
				${unreadField}
			FROM wpp_chats chat
			LEFT JOIN wpp_contacts ctt ON ctt.id = chat.contact_id
			LEFT JOIN clientes cli ON cli.CODIGO = ctt.customer_id
			${schedulesJoin}
			${lastMessageJoin}
			${unreadJoin}
			WHERE ${whereClause}
			${orderClause}
		`;

		const rows = await instancesService.executeQuery<any[]>(session.instance, query, params);

		const chats = rows.map((row) => {
			const contactId = row.contact_id ? Number(row.contact_id) : null;
			const customerId = row.contact_customer_id ? Number(row.contact_customer_id) : null;

			const contact = contactId
				? {
					id: contactId,
					name: safeDecode(row.contact_name),
					phone: row.contact_phone,
					phoneNumber: row.contact_phone,
					phone_number: row.contact_phone,
					customerId,
					WppMessage: [] as WppMessage[]
				}
				: null;

			const customer = customerId
				? {
					CODIGO: customerId,
					RAZAO: row.customer_RAZAO || null,
					FANTASIA: row.customer_FANTASIA || null,
					CPF_CNPJ: row.customer_CPF_CNPJ || null,
					COD_ERP: row.customer_COD_ERP || null
				}
				: null;

			// Montar lastMessage do JOIN se disponível
			let lastMessage: WppMessage | null = null;
			if (includeLastMessage && row.lm_message_id) {
				const sentAt = row.lm_sent_at ? new Date(row.lm_sent_at) : new Date();
				lastMessage = {
					id: Number(row.lm_message_id),
					instance: row.instance,
					wwebjsId: null,
					wwebjsIdStanza: null,
					wabaId: null,
					gupshupId: null,
					gupshupRequestId: null,
					from: row.lm_from,
					to: row.lm_to,
					type: row.lm_type,
					quotedId: null,
					chatId: row.lm_chat_id ? Number(row.lm_chat_id) : null,
					contactId: contactId,
					isForwarded: false,
					isEdited: false,
					body: safeDecode(row.lm_body),
					timestamp: row.lm_timestamp,
					sentAt,
					status: row.lm_status,
					fileId: row.lm_file_id ? Number(row.lm_file_id) : null,
					fileName: safeDecode(row.lm_file_name),
					fileType: row.lm_file_type || null,
					fileSize: row.lm_file_size || null,
					userId: row.lm_user_id ? Number(row.lm_user_id) : null,
					billingCategory: row.lm_billing_category || null,
					clientId: row.lm_client_id ? Number(row.lm_client_id) : null
				} as WppMessage;

				if (contact && !Number(row.is_finished)) {
					contact.WppMessage = [lastMessage];
				}
			}

			const isUnread = includeUnread ? (Number(row.unread_count) || 0) > 0 : false;

			const chat: any = {
				id: Number(row.id),
				instance: row.instance,
				type: row.type,
				avatarUrl: safeDecode(row.avatar_url),
				userId: row.user_id ? Number(row.user_id) : null,
				botId: null,
				contactId: contactId,
				sectorId: row.sector_id ? Number(row.sector_id) : null,
				startedAt: row.started_at ? new Date(row.started_at) : null,
				finishedAt: row.finished_at ? new Date(row.finished_at) : null,
				finishedBy: row.finished_by ? Number(row.finished_by) : null,
				resultId: row.result_id ? Number(row.result_id) : null,
				isFinished: Number(row.is_finished) === 1,
				isSchedule: Number(row.is_schedule) === 1,
				contact,
				customer,
				schedule: null,
				lastMessage,
				isUnread
			};

			return chat;
		});

		const chatIds = chats.map((chat) => chat.id).filter((id) => Number.isFinite(id));

		if (chatIds.length) {
			const placeholders = chatIds.map(() => "?").join(",");
			const schedulesQuery = `
				SELECT * FROM wpp_schedules
				WHERE instance = ? AND chat_id IN (${placeholders})
			`;
			const schedules = await instancesService.executeQuery<any[]>(
				session.instance,
				schedulesQuery,
				[session.instance, ...chatIds]
			);

			const scheduleMap = new Map<number, any>();
			schedules.forEach((schedule) => {
				const chatId = schedule.chat_id ? Number(schedule.chat_id) : null;
				if (!chatId) return;
				scheduleMap.set(chatId, {
					id: Number(schedule.id),
					instance: schedule.instance,
					description: safeDecode(schedule.description),
					contactId: Number(schedule.contact_id),
					chatId,
					scheduledAt: schedule.scheduled_at ? new Date(schedule.scheduled_at) : new Date(),
					scheduleDate: schedule.schedule_date ? new Date(schedule.schedule_date) : new Date(),
					scheduledBy: Number(schedule.scheduled_by),
					scheduledFor: Number(schedule.scheduled_for),
					sectorId: schedule.sector_id ? Number(schedule.sector_id) : null
				});
			});

			chats.forEach((chat) => {
				chat.schedule = scheduleMap.get(chat.id) || null;
			});
		}

		return chats;
	}

	private async getLocalSchedules(session: SessionData, filters: Record<string, any> = {}) {
		const params: any[] = [session.instance];
		let whereClause = "sch.instance = ? AND sch.chat_id IS NULL";

		// Filtro scheduledFor
		if (filters["scheduledFor"] && filters["scheduledFor"] !== "all") {
			whereClause += " AND sch.scheduled_for = ?";
			params.push(filters["scheduledFor"]);
		}

		// Filtro scheduledBy
		if (filters["scheduledBy"] && filters["scheduledBy"] !== "all") {
			whereClause += " AND sch.scheduled_by = ?";
			params.push(filters["scheduledBy"]);
		}

		// Filtro scheduledAt (data de agendamento)
		if (filters["scheduledAt"]?.from) {
			whereClause += " AND sch.scheduled_at >= ?";
			params.push(new Date(filters["scheduledAt"].from));
		}
		if (filters["scheduledAt"]?.to) {
			whereClause += " AND sch.scheduled_at <= ?";
			params.push(new Date(filters["scheduledAt"].to));
		}

		// Filtro scheduledTo (data para executar o agendamento)
		if (filters["scheduledTo"]?.from) {
			whereClause += " AND sch.schedule_date >= ?";
			params.push(new Date(filters["scheduledTo"].from));
		}
		if (filters["scheduledTo"]?.to) {
			whereClause += " AND sch.schedule_date <= ?";
			params.push(new Date(filters["scheduledTo"].to));
		}

		// Filtro de texto (busca)
		const searchText = String(filters["searchText"] || "").trim();
		const searchColumn = String(filters["searchColumn"] || "all");
		if (searchText) {
			const searchPattern = `%${searchText}%`;
			const conditions: string[] = [];

			if (searchColumn === "name" || searchColumn === "all") {
				conditions.push("ctt.name LIKE ?");
				params.push(searchPattern);
			}
			if (searchColumn === "phone" || searchColumn === "all") {
				conditions.push("ctt.phone LIKE ?");
				params.push(searchPattern);
			}
			if (searchColumn === "customer" || searchColumn === "all") {
				conditions.push("(cli.RAZAO LIKE ? OR cli.CPF_CNPJ LIKE ?)");
				params.push(searchPattern, searchPattern);
			}

			if (conditions.length > 0) {
				whereClause += " AND (" + conditions.join(" OR ") + ")";
			}
		}

		const query = `
			SELECT
				sch.id,
				sch.instance,
				sch.description,
				sch.contact_id,
				sch.chat_id,
				sch.scheduled_at,
				sch.schedule_date,
				sch.scheduled_by,
				sch.scheduled_for,
				sch.sector_id,
				ctt.id as contact_id_ref,
				ctt.name as contact_name,
				ctt.phone as contact_phone,
				ctt.customer_id as contact_customer_id,
				cli.CODIGO as customer_CODIGO,
				cli.RAZAO as customer_RAZAO,
				cli.FANTASIA as customer_FANTASIA,
				cli.CPF_CNPJ as customer_CPF_CNPJ,
				cli.COD_ERP as customer_COD_ERP
			FROM wpp_schedules sch
			LEFT JOIN wpp_contacts ctt ON ctt.id = sch.contact_id
			LEFT JOIN clientes cli ON cli.CODIGO = ctt.customer_id
			WHERE ${whereClause}
		`;

		const rows = await instancesService.executeQuery<any[]>(session.instance, query, params);

		return rows.map((row) => {
			const contactId = row.contact_id_ref ? Number(row.contact_id_ref) : null;
			const customerId = row.contact_customer_id ? Number(row.contact_customer_id) : null;
			const contact = contactId
				? {
					id: contactId,
					name: row.contact_name,
					phone: row.contact_phone,
					phoneNumber: row.contact_phone,
					phone_number: row.contact_phone,
					customerId
				}
				: null;

			const customer = customerId
				? {
					CODIGO: customerId,
					RAZAO: row.customer_RAZAO || null,
					FANTASIA: row.customer_FANTASIA || null,
					CPF_CNPJ: row.customer_CPF_CNPJ || null,
					COD_ERP: row.customer_COD_ERP || null
				}
				: null;

			return {
				id: Number(row.id),
				instance: row.instance,
				description: safeDecode(row.description),
				contactId: Number(row.contact_id),
				chatId: row.chat_id ? Number(row.chat_id) : null,
				scheduledAt: row.scheduled_at ? new Date(row.scheduled_at) : new Date(),
				scheduleDate: row.schedule_date ? new Date(row.schedule_date) : new Date(),
				scheduledBy: Number(row.scheduled_by),
				scheduledFor: Number(row.scheduled_for),
				sectorId: row.sector_id ? Number(row.sector_id) : null,
				contact,
				customer
			};
		});
	}
}

export default new MonitorService();
