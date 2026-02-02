import { SessionData } from "@in.pulse-crm/sdk";
import { WppMessage } from "@prisma/client";
import chatsService from "./chats.service";
import internalChatsService from "./internal-chats.service";
import schedulesService from "./schedules.service";
import instancesService from "./instances.service";

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
		return this.searchMonitorDataInternal(session, input, false);
	}

	public async searchMonitorDataLocal(session: SessionData, input: MonitorSearchInput) {
		return this.searchMonitorDataInternal(session, input, true);
	}

	private async searchMonitorDataInternal(
		session: SessionData,
		input: MonitorSearchInput,
		useLocal: boolean
	) {
		const page = Number(input.page) || 1;
		const pageSize = Number(input.pageSize) || 20;
		const filters = (input.filters as Record<string, any>) || {};

		const schedules = useLocal
			? await this.getLocalSchedules(session)
			: await schedulesService.getSchedulesBySession(session, {});
		const whatsappChatsRaw = useLocal
			? await this.getLocalWhatsappChats(session)
			: (await chatsService.getChatsMonitor(session, true, true)).chats;
		const { chats: internalChatsRaw } = await internalChatsService.getInternalChatsMonitor(session);

		const whatsappChats = whatsappChatsRaw.map((chat: any) => {
			const messages = chat?.contact?.WppMessage || chat?.messages || [];
			const lastMessage = messages.reduce((prev: any, curr: any) => {
				if (!prev) return curr;
				return (curr?.timestamp || 0) > (prev?.timestamp || 0) ? curr : prev;
			}, null);

			const isUnread = messages.some((m: any) => {
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

			return matchesSearch([...nameCandidates, ...lastMessageCandidates]);
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
				chat?.contact?.name,
				chat?.customer?.RAZAO,
				chat?.contact?.phone,
				chat?.contact?.phoneNumber,
				chat?.contact?.phone_number,
				chat?.contact?.formattedPhone,
				chat?.contact?.formattedPhoneNumber,
				chat?.contact?.phoneFormatted,
				chat?.contact?.shortName,
				chat?.contact?.shortPhone
			];
			const lastMessageCandidates: Array<string | null | undefined> = [
				chat?.lastMessageBody,
				chat?.lastMessage?.body,
				chat?.lastMessageText,
				chat?.lastMsg?.body,
				chat?.messages?.[chat?.messages?.length - 1]?.body,
				chat?.messages?.[0]?.body
			];

			return matchesSearch([...nameCandidates, ...lastMessageCandidates]);
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

			return matchesSearch([
				schedule?.contact?.name,
				schedule?.contact?.phone,
				schedule?.contact?.phoneNumber,
				schedule?.contact?.phone_number,
				schedule?.contact?.formattedPhone,
				schedule?.contact?.formattedPhoneNumber,
				schedule?.contact?.phoneFormatted,
				schedule?.customer?.RAZAO,
				schedule?.customer?.CPF_CNPJ
			]);
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

	private async getLocalWhatsappChats(session: SessionData) {
		const isTI = session.sectorId === 3 || session.instance !== "nunes";
		const params: any[] = [session.instance];
		let whereClause = "chat.instance = ?";

		if (!isTI) {
			whereClause += " AND chat.sector_id = ?";
			params.push(session.sectorId);
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
			FROM wpp_chats chat
			LEFT JOIN wpp_contacts ctt ON ctt.id = chat.contact_id
			LEFT JOIN clientes cli ON cli.CODIGO = ctt.customer_id
			WHERE ${whereClause}
		`;

		const rows = await instancesService.executeQuery<any[]>(session.instance, query, params);

		const chats = rows.map((row) => {
			const contactId = row.contact_id ? Number(row.contact_id) : null;
			const customerId = row.contact_customer_id ? Number(row.contact_customer_id) : null;

			const contact = contactId
				? {
					id: contactId,
					name: row.contact_name,
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

			return {
				id: Number(row.id),
				instance: row.instance,
				type: row.type,
				avatarUrl: row.avatar_url,
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
				schedule: null
			};
		});

		const chatIds = chats.map((chat) => chat.id).filter((id) => Number.isFinite(id));
		const contactIds = chats
			.map((chat) => chat.contactId)
			.filter((id): id is number => typeof id === "number");

		if (contactIds.length) {
			const placeholders = contactIds.map(() => "?").join(",");
			const messagesQuery = `
				SELECT * FROM wpp_messages
				WHERE instance = ? AND contact_id IN (${placeholders})
				ORDER BY sent_at ASC
			`;
			const messagesRows = await instancesService.executeQuery<any[]>(
				session.instance,
				messagesQuery,
				[session.instance, ...contactIds]
			);
			const messages = messagesRows.map((row) => {
				const sentAt = row.sent_at ? new Date(row.sent_at) : new Date();
				return {
					id: Number(row.id),
					instance: row.instance,
					wwebjsId: row.wwebjs_id || null,
					wwebjsIdStanza: row.wwebjs_id_stanza || null,
					wabaId: row.waba_id || null,
					gupshupId: row.gupshup_id || null,
					gupshupRequestId: row.gupshup_request_id || null,
					from: row.from,
					to: row.to,
					type: row.type,
					quotedId: row.quoted_id ? Number(row.quoted_id) : null,
					chatId: row.chat_id ? Number(row.chat_id) : null,
					contactId: row.contact_id ? Number(row.contact_id) : null,
					isForwarded: Number(row.is_forwarded) === 1,
					isEdited: Number(row.is_edited) === 1,
					body: row.body,
					timestamp: row.timestamp,
					sentAt,
					status: row.status,
					fileId: row.file_id ? Number(row.file_id) : null,
					fileName: row.file_name || null,
					fileType: row.file_type || null,
					fileSize: row.file_size || null,
					userId: row.user_id ? Number(row.user_id) : null,
					billingCategory: row.billing_category || null,
					clientId: row.client_id ? Number(row.client_id) : null
				} as WppMessage;
			});

			const messagesByContact = new Map<number, WppMessage[]>();
			messages.forEach((msg) => {
				const decoded =
					session.instance === "vollo" && typeof msg.body === "string"
						? (() => {
							try {
								return { ...msg, body: decodeURIComponent(msg.body) };
							} catch (e) {
								return msg;
							}
						})()
						: msg;
				const list = messagesByContact.get(decoded.contactId || 0) || [];
				list.push(decoded);
				if (decoded.contactId) {
					messagesByContact.set(decoded.contactId, list);
				}
			});

			chats.forEach((chat) => {
				if (!chat.contact || chat.isFinished) return;
				const contactMessages = messagesByContact.get(chat.contactId || 0) || [];
				chat.contact.WppMessage = contactMessages;
			});
		}

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
					description: schedule.description || null,
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

	private async getLocalSchedules(session: SessionData) {
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
			WHERE sch.instance = ? AND sch.chat_id IS NULL
		`;

		const rows = await instancesService.executeQuery<any[]>(session.instance, query, [session.instance]);

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
				description: row.description || null,
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
