import type { SessionData } from "../../sdk-local";
import { safeDecode } from "../../utils/safe-encode";
import type {
	MonitorCategory,
	MonitorFilters,
	MonitorOperational,
	MonitorRequest,
	MonitorSummary
} from "./monitor-contract";
import { buildMonitorQuery, monitorOrder, type MonitorQuery, type MonitorQueryContext } from "./monitor-query";

export type MonitorRow = Record<string, unknown>;
export type MonitorExecute = (local: boolean, query: MonitorQuery) => Promise<MonitorRow[]>;
export interface MonitorSource {
	category: MonitorCategory;
	local: boolean;
	query: MonitorQuery;
}
const number = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const iso = (value: unknown) => {
	const timestamp = number(value);
	return timestamp !== null && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};
export function mapMonitorRow(row: MonitorRow) {
	const category = row["category"] as MonitorCategory;
	const decoded = (value: unknown, message = false) => {
		if (value === null || value === undefined) return null;
		const text = String(value);
		return Number(row["text_encoded"]) === 1 || (message && row["instance"] === "vollo") ? safeDecode(text) : text;
	};
	const contactId = number(row["contact_id"]),
		customerId = number(row["customer_id"]);
	const contact =
		contactId === null
			? null
			: {
					id: contactId,
					name: decoded(row["contact_name"]) ?? "",
					phone: row["contact_phone"],
					phoneNumber: row["contact_phone"],
					customerId,
					WppMessage: []
				};
	const customer =
		customerId === null
			? null
			: {
					CODIGO: customerId,
					RAZAO: row["customer_name"] == null ? null : String(row["customer_name"]),
					FANTASIA: row["customer_fantasy"] == null ? null : String(row["customer_fantasy"]),
					CPF_CNPJ: row["customer_document"] ?? null,
					COD_ERP: row["customer_erp"] ?? null
				};
	const operational: MonitorOperational = {
		status: row["operational_status"] as MonitorOperational["status"],
		lastMessageAt: iso(row["lm_at"]),
		lastMessagePreview: decoded(row["lm_body"], true),
		waitingSince:
			row["operational_status"] === "waiting_agent" || row["operational_status"] === "waiting_customer"
				? iso(row["waiting_since"])
				: null,
		unreadCount: number(row["unread_count"]),
		channel: category === "internal" ? "INTERNAL" : null,
		deliveryStatus:
			row["outgoing_status"] === null || row["outgoing_status"] === undefined
				? null
				: String(row["outgoing_status"]),
		slaBreached:
			row["sla_breached"] === null || row["sla_breached"] === undefined
				? null
				: Boolean(Number(row["sla_breached"]))
	};
	const lastMessage =
		row["lm_id"] === null || row["lm_id"] === undefined
			? null
			: {
					id: number(row["lm_id"]),
					instance: row["instance"],
					from: row["lm_from"],
					to: row["lm_to"],
					type: row["lm_type"],
					body: decoded(row["lm_body"], true),
					timestamp: String(row["lm_at"]),
					sentAt: iso(row["lm_at"]),
					status: row["lm_status"],
					clientId: number(row["lm_client_id"]),
					chatId: category === "wpp" ? number(row["id"]) : null,
					internalChatId: category === "internal" ? number(row["id"]) : null,
					contactId
				};
	const schedule =
		row["schedule_id"] === null
			? null
			: {
					id: number(row["schedule_id"]),
					instance: row["instance"],
					contactId,
					chatId: category === "wpp" ? number(row["id"]) : null,
					description: decoded(row["description"]),
					scheduledAt: iso(row["scheduled_at"]),
					scheduleDate: iso(row["schedule_date"]),
					scheduledBy: number(row["scheduled_by"]),
					scheduledFor: number(row["scheduled_for"]),
					sectorId: number(row["sector_id"])
				};
	return {
		id: Number(row["id"]),
		instance: String(row["instance"]),
		chatType: category === "schedule" ? undefined : category,
		type: row["type"],
		sectorId: number(row["sector_id"]),
		userId: number(row["user_id"]),
		creatorId: category === "internal" ? number(row["user_id"]) : null,
		botId: number(row["bot_id"]),
		resultId: number(row["result_id"]),
		contactId,
		contact,
		customer,
		avatarUrl: decoded(row["avatar_url"]),
		startedAt: iso(row["started_at"]),
		finishedAt: iso(row["finished_at"]),
		finishedBy: number(row["finished_by"]),
		isFinished: Boolean(Number(row["is_finished"])),
		isSchedule: Boolean(Number(row["is_schedule"])),
		isGroup: Boolean(Number(row["is_group"])),
		groupName: decoded(row["group_name"]),
		groupDescription: decoded(row["group_description"]),
		groupImageFileId: number(row["group_image_file_id"]),
		wppGroupId: row["wpp_group_id"],
		participants: [] as Array<{ userId: number; internalChatId: number; joinedAt: unknown; lastReadAt: unknown }>,
		messages: [],
		lastMessage,
		isUnread: (operational.unreadCount ?? 0) > 0,
		operational,
		...(category === "schedule" ? schedule : { schedule })
	};
}
export type MonitorItem = ReturnType<typeof mapMonitorRow>;

export function monitorSources(context: MonitorQueryContext): MonitorSource[] {
	const sources: MonitorSource[] = [];
	const categories: MonitorCategory[] = ["wpp", "internal", "schedule"];
	for (const category of categories) {
		if (category === "wpp" && !context.filters.categories.showCustomerChats) continue;
		if (category === "schedule" && !context.filters.categories.showSchedules) continue;
		if (
			category === "internal" &&
			!context.filters.categories.showInternalChats &&
			!context.filters.categories.showInternalGroups
		)
			continue;
		const local = category !== "internal" && context.local;
		sources.push({ category, local, query: buildMonitorQuery(category, { ...context, local }) });
	}
	return sources;
}
export async function monitorSummary(
	execute: MonitorExecute,
	sources: MonitorSource[],
	slaMinutes: number | null
): Promise<MonitorSummary> {
	const summary: MonitorSummary = {
		inProgress: 0,
		waitingAgent: 0,
		waitingCustomer: 0,
		unread: 0,
		overdue: 0,
		scheduled: 0,
		slaMinutes
	};
	const rows = await Promise.all(
		sources.map((source) =>
			execute(source.local, {
				sql: `SELECT SUM(operational_status IN ('in_progress','waiting_agent','waiting_customer')) AS in_progress, SUM(operational_status = 'waiting_agent') AS waiting_agent, SUM(operational_status = 'waiting_customer') AS waiting_customer, SUM(unread_count > 0) AS unread, SUM(sla_breached = 1) AS overdue, SUM(upcoming = 1) AS scheduled FROM (${source.query.sql}) monitor_summary`,
				params: source.query.params
			})
		)
	);
	for (const [row] of rows) {
		summary.inProgress += Number(row?.["in_progress"] ?? 0);
		summary.waitingAgent += Number(row?.["waiting_agent"] ?? 0);
		summary.waitingCustomer += Number(row?.["waiting_customer"] ?? 0);
		summary.unread += Number(row?.["unread"] ?? 0);
		summary.overdue += Number(row?.["overdue"] ?? 0);
		summary.scheduled += Number(row?.["scheduled"] ?? 0);
	}
	return summary;
}

export function compareMonitorRows(a: MonitorRow, b: MonitorRow, filters: MonitorFilters): number {
	const direction = filters.sortOrder === "asc" ? 1 : -1;
	const priority = Number(a["sort_priority"]) - Number(b["sort_priority"]);
	if (priority) return priority * direction;
	const av = filters.sortBy === "name" ? String(a["sort_value"]) : Number(a["sort_value"]);
	const bv = filters.sortBy === "name" ? String(b["sort_value"]) : Number(b["sort_value"]);
	if (av !== bv) return (av < bv ? -1 : 1) * direction;
	return Number(a["id"]) - Number(b["id"]) || String(a["category"]).localeCompare(String(b["category"]));
}

/** UNION categories in each database. When two databases are involved, find the
 * page boundary by binary partition; never read/retain the entire skipped prefix. */
export async function monitorPage(execute: MonitorExecute, sources: MonitorSource[], request: MonitorRequest) {
	const groups = [false, true].flatMap((local) => {
		const matching = sources.filter((source) => source.local === local);
		return matching.length
			? [
					{
						local,
						query: {
							sql: matching.map((source) => source.query.sql).join(" UNION ALL "),
							params: matching.flatMap((source) => source.query.params)
						}
					}
				]
			: [];
	});
	const counts = await Promise.all(
		groups.map((source) =>
			execute(source.local, {
				sql: `SELECT COUNT(*) AS total FROM (${source.query.sql}) monitor_count`,
				params: source.query.params
			})
		)
	);
	const totalCount = counts.reduce((sum, [row]) => sum + Number(row?.["total"] ?? 0), 0);
	const start = (request.page - 1) * request.pageSize;
	if (start >= totalCount)
		return { rows: [] as MonitorRow[], totalCount, page: request.page, pageSize: request.pageSize };
	const order = monitorOrder(request.filters);
	const read = async (group: (typeof groups)[number], offset: number, limit: number) =>
		execute(group.local, {
			sql: `SELECT monitor_rows.*, ${order.projection} FROM (${group.query.sql}) monitor_rows ORDER BY ${order.order} LIMIT ? OFFSET ?`,
			params: [...group.query.params, limit, offset]
		});
	if (groups.length === 1) {
		return {
			rows: await read(groups[0]!, start, request.pageSize),
			totalCount,
			page: request.page,
			pageSize: request.pageSize
		};
	}
	const first = groups[0]!,
		second = groups[1]!;
	const firstCount = Number(counts[0]?.[0]?.["total"] ?? 0),
		secondCount = Number(counts[1]?.[0]?.["total"] ?? 0);
	let low = Math.max(0, start - secondCount),
		high = Math.min(start, firstCount),
		firstOffset = low;
	while (low <= high) {
		const a = Math.floor((low + high) / 2),
			b = start - a;
		const [aa, bb] = await Promise.all([read(first, Math.max(0, a - 1), 2), read(second, Math.max(0, b - 1), 2)]);
		const previousA = a > 0 ? aa[0] : undefined,
			nextA = aa[a > 0 ? 1 : 0];
		const previousB = b > 0 ? bb[0] : undefined,
			nextB = bb[b > 0 ? 1 : 0];
		if (previousA && nextB && compareMonitorRows(previousA, nextB, request.filters) > 0) high = a - 1;
		else if (previousB && nextA && compareMonitorRows(previousB, nextA, request.filters) > 0) low = a + 1;
		else {
			firstOffset = a;
			break;
		}
		firstOffset = low;
	}
	const candidates = await Promise.all([
		read(first, firstOffset, request.pageSize),
		read(second, start - firstOffset, request.pageSize)
	]);
	const rows = candidates
		.flat()
		.sort((a, b) => compareMonitorRows(a, b, request.filters))
		.slice(0, request.pageSize);
	return { rows, totalCount, page: request.page, pageSize: request.pageSize };
}

export function monitorScope(session: SessionData, alias: string): MonitorQuery {
	return session.instance === "nunes" && session.sectorId !== 3
		? { sql: `${alias}.instance = ? AND ${alias}.sector_id = ?`, params: [session.instance, session.sectorId] }
		: { sql: `${alias}.instance = ?`, params: [session.instance] };
}
