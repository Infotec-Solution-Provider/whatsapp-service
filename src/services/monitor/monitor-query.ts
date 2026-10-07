import type { SessionData } from "../../sdk-local";
import type { DateRange, MonitorCategory, MonitorFilters } from "./monitor-contract";
import { SCHEDULE_WINDOW_HOURS } from "./monitor-contract";

export interface MonitorQuery {
	sql: string;
	params: unknown[];
}
export interface MonitorQueryContext {
	session: SessionData;
	filters: MonitorFilters;
	local: boolean;
	slaMinutes: number | null;
	now: Date;
	customerIds: number[];
	localTimezoneOffsetMinutes?: number;
}
// Use the same epoch expression in both databases; UNIX_TIMESTAMP depends on the connection timezone.
const millis = (column: string) => `TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', ${column}) / 1000`;
export const inboundSql = (alias: string) =>
	`${alias}.\`from\` <> '' AND ${alias}.\`from\` NOT LIKE 'me:%' AND ${alias}.\`from\` NOT LIKE 'user:%' AND ${alias}.\`from\` NOT LIKE 'bot%' AND ${alias}.\`from\` NOT LIKE 'system%' AND ${alias}.\`from\` NOT LIKE 'thirdparty%'`;
const humanSql = (alias: string) => `(${alias}.\`from\` LIKE 'me:%' OR ${alias}.\`from\` LIKE 'user:%')`;
const conversationSql = (alias: string) => `(${inboundSql(alias)} OR ${humanSql(alias)})`;
export function monitorLike(value: string): string {
	return `%${value.replace(/[=%_]/g, "=$&")}%`;
}

export function buildMonitorQuery(category: MonitorCategory, context: MonitorQueryContext): MonitorQuery {
	const { session, filters: f, local, now, slaMinutes, customerIds } = context;
	// Legacy sync writes wall time with getHours(). Messages also retain an absolute
	// epoch timestamp; use it for waits. Other local dates follow that writer's timezone.
	const offset =
		local && category !== "internal" ? (context.localTimezoneOffsetMinutes ?? now.getTimezoneOffset()) * 60000 : 0;
	const dateMillis = (column: string) => `(${millis(column)} + ${offset})`;
	const boundDate = (value: string) =>
		local && category !== "internal"
			? new Date(Date.parse(value) - offset).toISOString().replace("T", " ").replace("Z", "")
			: new Date(value);
	const params: unknown[] = [],
		conditions: string[] = [];
	const add = (sql: string, ...values: unknown[]) => {
		conditions.push(sql);
		params.push(...values);
	};
	const range = (column: string, value: DateRange) => {
		if (value.from) add(`${column} >= ?`, boundDate(value.from));
		if (value.to) add(`${column} <= ?`, boundDate(value.to));
	};
	const prefix = local && category !== "internal" ? "wpp_" : "";
	const table = category === "internal" ? "internalchats" : `${prefix}${category === "wpp" ? "chats" : "schedules"}`;
	const id = local && category === "wpp" ? "c.original_id" : "c.id";
	const messages = category === "internal" ? "internalmessages" : `${prefix}messages`;
	const chatColumn = category === "internal" ? "internalchat_id" : "chat_id";
	const latest = (alias: string, extra = "") =>
		`SELECT ${alias}.id FROM ${messages} ${alias} WHERE ${alias}.instance = c.instance AND ${alias}.${chatColumn} = ${id} ${extra} ORDER BY ${category === "internal" ? `CAST(${alias}.timestamp AS UNSIGNED)` : `${alias}.sent_at`} DESC, ${alias}.id DESC LIMIT 1`;
	const joins: string[] = [];
	const projection: Record<string, string> = {
		id,
		instance: "c.instance",
		category: `'${category}'`,
		sector_id: "c.sector_id",
		text_encoded: local && category !== "internal" ? "1" : "0",
		contact_id: "NULL",
		contact_name: "NULL",
		contact_phone: "NULL",
		customer_id: "NULL",
		customer_name: "NULL",
		customer_fantasy: "NULL",
		customer_document: "NULL",
		customer_erp: "NULL",
		user_id: "NULL",
		bot_id: "NULL",
		type: "NULL",
		avatar_url: "NULL",
		is_finished: "0",
		is_schedule: "0",
		started_at: "NULL",
		finished_at: "NULL",
		finished_by: "NULL",
		result_id: "NULL",
		is_group: "0",
		group_name: "NULL",
		group_description: "NULL",
		group_image_file_id: "NULL",
		wpp_group_id: "NULL",
		schedule_id: "NULL",
		description: "NULL",
		scheduled_at: "NULL",
		schedule_date: "NULL",
		scheduled_by: "NULL",
		scheduled_for: "NULL",
		lm_id: "NULL",
		lm_from: "NULL",
		lm_to: "NULL",
		lm_type: "NULL",
		lm_body: "NULL",
		lm_at: "NULL",
		lm_status: "NULL",
		lm_client_id: "NULL",
		outgoing_id: "NULL",
		outgoing_status: "NULL",
		unread_count: "NULL",
		waiting_since: "NULL",
		operational_status: "'scheduled'"
	};
	add("c.instance = ?", session.instance);
	// Existing Monitor access rule. Apply to schedules as well to avoid exposing another sector through its pending queue.
	if (session.instance === "nunes" && session.sectorId !== 3) add("c.sector_id = ?", session.sectorId);
	if (category !== "internal") {
		joins.push(`LEFT JOIN ${prefix}contacts ct ON ct.id = c.contact_id AND ct.instance = c.instance`);
		Object.assign(projection, {
			contact_id: "c.contact_id",
			contact_name: "ct.name",
			contact_phone: "ct.phone",
			customer_id: "ct.customer_id"
		});
		if (local) {
			joins.push("LEFT JOIN clientes cu ON cu.CODIGO = ct.customer_id");
			Object.assign(projection, {
				customer_name: "cu.RAZAO",
				customer_fantasy: "cu.FANTASIA",
				customer_document: "cu.CPF_CNPJ",
				customer_erp: "cu.COD_ERP"
			});
		}
	}
	if (category === "schedule") {
		if (!f.categories.showSchedules) add("1 = 0");
		add("c.chat_id IS NULL");
		if (f.user !== "all") add("c.scheduled_for = ?", f.user);
		Object.assign(projection, {
			schedule_id: "c.id",
			description: "c.description",
			scheduled_at: dateMillis("c.scheduled_at"),
			schedule_date: dateMillis("c.schedule_date"),
			scheduled_by: "c.scheduled_by",
			scheduled_for: "c.scheduled_for"
		});
	} else {
		Object.assign(projection, {
			is_finished: "c.is_finished",
			started_at: dateMillis("c.started_at"),
			finished_at: dateMillis("c.finished_at"),
			finished_by: "c.finished_by"
		});
		if (!f.showOngoing && !f.showFinished) add("1 = 0");
		else if (!f.showFinished) add("c.is_finished = 0");
		else if (!f.showOngoing) add("c.is_finished = 1");
		range("c.started_at", f.startedAt);
		range("c.finished_at", f.finishedAt);
		joins.push(`LEFT JOIN ${messages} lm ON lm.id = (${latest("last_msg")}) AND lm.instance = c.instance`);
		Object.assign(projection, {
			lm_id: "lm.id",
			lm_from: "lm.`from`",
			lm_type: "lm.type",
			lm_body: "LEFT(lm.body, 1000)",
			lm_at: "CAST(lm.timestamp AS UNSIGNED)",
			lm_status: "lm.status",
			lm_client_id: "lm.client_id"
		});
		if (category === "internal") {
			if (!f.categories.showInternalChats && !f.categories.showInternalGroups) add("1 = 0");
			else if (!f.categories.showInternalChats) add("c.is_group = 1");
			else if (!f.categories.showInternalGroups) add("c.is_group = 0");
			if (
				f.showOnlyScheduled ||
				f.scheduledBy !== "all" ||
				f.scheduledFor !== "all" ||
				f.scheduledAt.from ||
				f.scheduledAt.to ||
				f.scheduledTo.from ||
				f.scheduledTo.to
			)
				add("1 = 0");
			if (f.user !== "all")
				add(
					"EXISTS (SELECT 1 FROM internal_chat_members selected_member WHERE selected_member.internalchatId = c.id AND selected_member.internalcontactId = ?)",
					f.user
				);
			// Unread is meaningful only when the monitoring user is a member. Never count their own messages.
			joins.push(
				`LEFT JOIN internal_chat_members viewer ON viewer.internalchatId = c.id AND viewer.internalcontactId = ${session.userId}`
			);
			Object.assign(projection, {
				user_id: "c.user_id",
				is_group: "c.is_group",
				group_name: "c.group_name",
				group_description: "c.group_description",
				group_image_file_id: "c.group_image_file_id",
				wpp_group_id: "c.wpp_group_id",
				operational_status: "CASE WHEN c.is_finished = 1 THEN 'finished' ELSE 'in_progress' END",
				unread_count: `CASE WHEN viewer.internalcontactId IS NULL THEN NULL ELSE (SELECT COUNT(*) FROM internalmessages unread_msg WHERE unread_msg.instance = c.instance AND unread_msg.internalchat_id = c.id AND unread_msg.\`from\` <> CONCAT('user:', viewer.internalcontactId) AND unread_msg.\`from\` NOT LIKE 'system%' AND CAST(unread_msg.timestamp AS UNSIGNED) > COALESCE(${millis("viewer.last_read_at")}, 0)) END`
			});
		} else {
			if (!f.categories.showCustomerChats) add("1 = 0");
			if (!f.showBots) add("(c.bot_id IS NULL OR c.bot_id = 0)");
			if (f.user !== "all") add("c.user_id = ?", f.user);
			if (f.showOnlyScheduled) add("c.is_schedule = 1");
			joins.push(`LEFT JOIN ${prefix}schedules sch ON sch.chat_id = ${id} AND sch.instance = c.instance`);
			joins.push(
				`LEFT JOIN ${messages} interaction ON interaction.id = (${latest("interaction_msg", `AND ${conversationSql("interaction_msg")} AND (${inboundSql("interaction_msg")} OR interaction_msg.status IN ('SENT', 'RECEIVED', 'READ'))`)}) AND interaction.instance = c.instance`
			);
			joins.push(
				`LEFT JOIN ${messages} outgoing ON outgoing.id = (${latest("outgoing_msg", `AND ${humanSql("outgoing_msg")}`)}) AND outgoing.instance = c.instance`
			);
			joins.push(
				`LEFT JOIN ${messages} responded ON responded.id = (${latest("responded_msg", `AND ${humanSql("responded_msg")} AND responded_msg.status IN ('SENT', 'RECEIVED', 'READ')`)}) AND responded.instance = c.instance`
			);
			const pending = `SELECT MIN(CAST(waiting_msg.timestamp AS UNSIGNED)) FROM ${messages} waiting_msg WHERE waiting_msg.instance = c.instance AND waiting_msg.chat_id = ${id} AND ${inboundSql("waiting_msg")} AND (responded.id IS NULL OR waiting_msg.sent_at > responded.sent_at OR (waiting_msg.sent_at = responded.sent_at AND waiting_msg.id > responded.id))`;
			Object.assign(projection, {
				user_id: "c.user_id",
				bot_id: "c.bot_id",
				type: "c.type",
				avatar_url: "c.avatar_url",
				is_schedule: "c.is_schedule",
				result_id: "c.result_id",
				lm_to: "lm.`to`",
				schedule_id: "sch.id",
				description: "sch.description",
				scheduled_at: dateMillis("sch.scheduled_at"),
				schedule_date: dateMillis("sch.schedule_date"),
				scheduled_by: "sch.scheduled_by",
				scheduled_for: "sch.scheduled_for",
				outgoing_id: "outgoing.id",
				outgoing_status: "outgoing.status",
				unread_count: `(SELECT COUNT(*) FROM ${messages} unread_msg WHERE unread_msg.instance = c.instance AND unread_msg.chat_id = ${id} AND unread_msg.status <> 'READ' AND ${inboundSql("unread_msg")})`,
				waiting_since: `CASE WHEN ${humanSql("interaction")} THEN CAST(interaction.timestamp AS UNSIGNED) ELSE COALESCE((${pending}), ${dateMillis("c.started_at")}) END`,
				operational_status: `CASE WHEN c.is_finished = 1 THEN 'finished' WHEN COALESCE(c.bot_id, 0) <> 0 THEN 'in_progress' WHEN c.user_id IS NULL OR c.user_id = 0 THEN 'waiting_agent' WHEN ${inboundSql("interaction")} THEN 'waiting_agent' WHEN ${humanSql("interaction")} AND interaction.status IN ('SENT', 'RECEIVED', 'READ') THEN 'waiting_customer' ELSE 'in_progress' END`
			});
		}
	}
	if (category !== "internal") {
		const scheduleAlias = category === "schedule" ? "c" : "sch";
		if (f.scheduledBy !== "all") add(`${scheduleAlias}.scheduled_by = ?`, f.scheduledBy);
		if (f.scheduledFor !== "all") add(`${scheduleAlias}.scheduled_for = ?`, f.scheduledFor);
		range(`${scheduleAlias}.scheduled_at`, f.scheduledAt);
		range(`${scheduleAlias}.schedule_date`, f.scheduledTo);
	}
	if (f.searchText) {
		const searchConditions: string[] = [];
		const match = (column: string) => {
			searchConditions.push(`${column} LIKE ? ESCAPE '='`);
			params.push(monitorLike(f.searchText));
			if (local && category !== "internal" && encodeURIComponent(f.searchText) !== f.searchText) {
				searchConditions.push(`${column} LIKE ? ESCAPE '='`);
				params.push(monitorLike(encodeURIComponent(f.searchText)));
			}
		};
		if (f.searchColumn === "all" || f.searchColumn === "name")
			match(category === "internal" ? "c.group_name" : "ct.name");
		if (category !== "internal" && (f.searchColumn === "all" || f.searchColumn === "phone")) {
			match("ct.phone");
			const digits = f.searchText.replace(/\D/g, "");
			if (digits.length >= 3 && digits !== f.searchText) {
				searchConditions.push("ct.phone LIKE ? ESCAPE '='");
				params.push(monitorLike(digits));
			}
		}
		if (category !== "internal" && (f.searchColumn === "all" || f.searchColumn === "customer")) {
			if (local) {
				match("cu.RAZAO");
				match("cu.CPF_CNPJ");
			} else if (customerIds.length) {
				searchConditions.push(`ct.customer_id IN (${customerIds.map(() => "?").join(",")})`);
				params.push(...customerIds);
			}
		}
		if (f.searchColumn === "all" || f.searchColumn === "message")
			match(category === "schedule" ? "c.description" : "lm.body");
		conditions.push(searchConditions.length ? `(${searchConditions.join(" OR ")})` : "1 = 0");
	}
	const base = `SELECT ${Object.entries(projection)
		.map(([alias, expression]) => `${expression} AS ${alias}`)
		.join(",\n")} FROM ${table} c ${joins.join("\n")} WHERE ${conditions.join(" AND ")}`;
	const sla =
		category === "wpp" && slaMinutes !== null
			? `CASE WHEN operational_status = 'waiting_agent' AND waiting_since IS NOT NULL THEN waiting_since <= ${now.getTime() - slaMinutes * 60000} ELSE 0 END`
			: "NULL";
	const decorated = `SELECT base.*, ${sla} AS sla_breached, CASE WHEN category = 'schedule' AND schedule_date <= ${now.getTime() + SCHEDULE_WINDOW_HOURS * 3600000} THEN 1 ELSE 0 END AS upcoming FROM (${base}) base`;
	const operational: string[] = [];
	if (f.showUnreadOnly) operational.push("unread_count > 0");
	if (f.showPendingResponseOnly) operational.push("operational_status = 'waiting_agent'");
	if (f.operationalStatus === "unread") operational.push("unread_count > 0");
	else if (f.operationalStatus === "overdue") operational.push("sla_breached = 1");
	else if (f.operationalStatus === "scheduled") operational.push("upcoming = 1");
	else if (f.operationalStatus !== "all") {
		operational.push(
			f.operationalStatus === "in_progress"
				? "operational_status IN ('in_progress', 'waiting_agent', 'waiting_customer')"
				: `operational_status = '${f.operationalStatus}'`
		);
	}
	const filtered = `SELECT decorated.* FROM (${decorated}) decorated${operational.length ? ` WHERE ${operational.join(" AND ")}` : ""}`;
	return { sql: filtered, params };
}

export function monitorOrder(filters: MonitorFilters): { projection: string; order: string } {
	const direction = filters.sortOrder.toUpperCase();
	let priority = "0",
		value: string;
	if (filters.sortBy === "urgency") {
		priority =
			"CASE WHEN sla_breached = 1 THEN 5 WHEN operational_status = 'waiting_agent' THEN 4 WHEN upcoming = 1 THEN 3 WHEN unread_count > 0 THEN 2 WHEN operational_status IN ('in_progress', 'waiting_customer') THEN 1 ELSE 0 END";
		value =
			"-COALESCE(CASE WHEN operational_status = 'waiting_agent' THEN waiting_since WHEN category = 'schedule' THEN schedule_date ELSE lm_at END, started_at, 0)";
	} else if (filters.sortBy === "name")
		value = "HEX(CONVERT(LOWER(COALESCE(contact_name, group_name, '')) USING utf8mb4))";
	else {
		const columns = {
			startedAt: "started_at",
			finishedAt: "finished_at",
			lastMessage: "lm_at",
			scheduledAt: "schedule_date"
		};
		value = `COALESCE(${columns[filters.sortBy]}, 0)`;
	}
	return {
		projection: `${priority} AS sort_priority, ${value} AS sort_value`,
		order: `sort_priority ${direction}, sort_value ${direction}, id ASC, category ASC`
	};
}
