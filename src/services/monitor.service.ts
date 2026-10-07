import type { SessionData } from "../sdk-local";
import chatsService from "./chats.service";
import internalChatsService from "./internal-chats.service";
import schedulesService from "./schedules.service";
import instancesService from "./instances.service";
import prismaService from "./prisma.service";
import parametersService from "./parameters.service";
import { parseMonitorRequest, parseSlaMinutes, type MonitorSearchInput } from "./monitor/monitor-contract";
import { monitorLike, type MonitorQueryContext } from "./monitor/monitor-query";
import {
	mapMonitorRow,
	monitorPage,
	monitorSources,
	monitorSummary,
	type MonitorExecute,
	type MonitorRow
} from "./monitor/monitor-reader";
import { readMonitorMessages, type MonitorHistoryInput } from "./monitor/monitor-history";
import messagePresentationService from "./message-presentation.service";

class MonitorService {
	public async getMonitorData(session: SessionData) {
		// Preserve the legacy response for callers not yet migrated to paginated search.
		const schedules = await schedulesService.getSchedulesBySession(session, {});
		const { chats: whatsappChats } = await chatsService.getChatsMonitor(session, true, true);
		const { chats: internalChats } = await internalChatsService.getInternalChatsMonitor(session);
		return { schedules, whatsappChats, internalChats };
	}

	private execute(session: SessionData): MonitorExecute {
		return (local, query) =>
			local
				? instancesService.executeQuery<MonitorRow[]>(session.instance, query.sql, query.params)
				: prismaService.$queryRawUnsafe<MonitorRow[]>(query.sql, ...query.params);
	}

	private async context(session: SessionData, input: MonitorSearchInput, summary = false) {
		const request = parseMonitorRequest(input);
		if (summary) request.filters.operationalStatus = "all";
		const params = await parametersService.getSessionParams(session);
		const local = params["monitor:use_local_search"] === "true";
		const slaMinutes = parseSlaMinutes(params["monitor:sla_minutes"]);
		const { searchText, searchColumn, categories } = request.filters;
		// Central WhatsApp has customer IDs; names live in the CRM. Fetch matching IDs
		// only for this optional filter and full customer details only for the final page.
		const customers =
			!local &&
			(categories.showCustomerChats || categories.showSchedules) &&
			searchText &&
			(searchColumn === "all" || searchColumn === "customer")
				? await instancesService.executeQuery<Array<{ CODIGO: number }>>(
						session.instance,
						"SELECT CODIGO FROM clientes WHERE RAZAO LIKE ? ESCAPE '=' OR CPF_CNPJ LIKE ? ESCAPE '='",
						[monitorLike(searchText), monitorLike(searchText)]
					)
				: [];
		const context: MonitorQueryContext = {
			session,
			filters: request.filters,
			local,
			slaMinutes,
			now: new Date(),
			customerIds: customers.map((customer) => Number(customer.CODIGO))
		};
		return { context, request };
	}

	public async searchMonitorData(session: SessionData, input: MonitorSearchInput) {
		const { context, request } = await this.context(session, input);
		const { rows, ...page } = await monitorPage(this.execute(session), monitorSources(context), request);
		const items = rows.map(mapMonitorRow);
		const internalIds = rows.filter((row) => row["category"] === "internal").map((row) => Number(row["id"]));
		const clientIds = [
			...new Set(rows.filter((row) => row["lm_client_id"] !== null).map((row) => Number(row["lm_client_id"])))
		];
		const outgoingIds = rows.filter((row) => row["outgoing_id"] !== null).map((row) => Number(row["outgoing_id"]));
		const customerIds = [
			...new Set(items.flatMap((item) => (item.customer?.CODIGO ? [item.customer.CODIGO] : [])))
		];
		const [members, clients, attempts, customers] = await Promise.all([
			internalIds.length
				? prismaService.internalChatMember.findMany({
						where: { internalChatId: { in: internalIds }, chat: { instance: session.instance } }
					})
				: [],
			clientIds.length
				? prismaService.wppClient.findMany({
						where: { instance: session.instance, id: { in: clientIds } },
						select: { id: true, type: true }
					})
				: [],
			outgoingIds.length
				? prismaService.operatorOutboundSend.findMany({
						where: { instance: session.instance, messageId: { in: outgoingIds } },
						select: { messageId: true, status: true }
					})
				: [],
			!context.local && customerIds.length
				? instancesService.executeQuery<
						Array<{ CODIGO: number; RAZAO: string; FANTASIA: string; CPF_CNPJ: string; COD_ERP: string }>
					>(
						session.instance,
						"SELECT CODIGO, RAZAO, FANTASIA, CPF_CNPJ, COD_ERP FROM clientes WHERE CODIGO IN (" +
							customerIds.map(() => "?").join(",") +
							")",
						customerIds
					)
				: []
		]);
		items.forEach((item, index) => {
			item.participants = members.filter(
				(member) => item.chatType === "internal" && member.internalChatId === item.id
			);
			const client = clients.find((candidate) => candidate.id === Number(rows[index]?.["lm_client_id"]));
			if (client && item.chatType === "wpp") item.operational.channel = client.type;
			const attempt = attempts.find((candidate) => candidate.messageId === Number(rows[index]?.["outgoing_id"]));
			if (attempt && attempt.status !== "SENT") item.operational.deliveryStatus = attempt.status;
			if (!context.local && item.customer)
				item.customer =
					customers.find((candidate) => Number(candidate.CODIGO) === item.customer!.CODIGO) ?? item.customer;
		});
		return { ...page, items };
	}

	public async getMonitorSummary(session: SessionData, input: MonitorSearchInput) {
		const { context } = await this.context(session, input, true);
		return monitorSummary(this.execute(session), monitorSources(context), context.slaMinutes);
	}

	public async getMonitorMessages(session: SessionData, input: MonitorHistoryInput) {
		const parameters = await parametersService.getSessionParams(session);
		const history = await readMonitorMessages(
			this.execute(session),
			session,
			parameters["monitor:use_local_search"] === "true",
			input
		);
		const all = [
			...new Map(
				[...history.messages, ...history.quotedMessages].map((message) => [Number(message["id"]), message])
			).values()
		];
		const presentable = all.map((message) => ({
			...message,
			id: Number(message["id"]),
			instance: session.instance,
			status: String(message["status"] ?? ""),
			clientId: message["clientId"] == null ? null : Number(message["clientId"]),
			...(input.type === "internal" ? { internalChatId: Number(input.id) } : {})
		}));
		const hydrated = await messagePresentationService.hydrate(
			session.instance,
			presentable,
			input.type === "internal" ? "internal" : "wpp"
		);
		const byId = new Map(hydrated.map((message) => [message.id, message]));
		return {
			messages: history.messages.map((message) => byId.get(Number(message["id"]))!),
			quotedMessages: history.quotedMessages.map((message) => byId.get(Number(message["id"]))!),
			nextCursor: history.nextCursor
		};
	}
}

export default new MonitorService();
