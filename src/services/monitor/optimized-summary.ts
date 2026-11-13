import type { MonitorFilters, MonitorSummary } from "./monitor-contract";
import { buildMonitorQuery, inboundSql, monitorLike, type MonitorQueryContext, type MonitorQuery } from "./optimized-query";
import { hasOptimizedCentralScope } from "./optimized-access";

type SummaryRow = Record<string, bigint | number | null>;
export type SummaryExecute = (sql: string, ...params: unknown[]) => Promise<SummaryRow[]>;
const keys = ["inProgress", "waitingAgent", "waitingCustomer", "unread", "overdue", "scheduled"] as const;
const totals = "SUM(operational_status IN ('in_progress','waiting_agent','waiting_customer')) AS inProgress, SUM(operational_status='waiting_agent') AS waitingAgent, SUM(operational_status='waiting_customer') AS waitingCustomer, SUM(unread_count>0) AS unread";

/** Aggregate message facts once per selected chat; do not execute latest/unread subqueries for every chat. */
export function buildOptimizedWhatsappSummary(context: MonitorQueryContext, overdueOnly = false, closedUnreadOnly = false, includeOverdue = false): MonitorQuery {
  const { session, slaMinutes, now, customerIds } = context;
  const f: MonitorFilters = { ...context.filters, operationalStatus: "all" };
  const params: unknown[] = [session.instance], conditions = ["c.instance = ?"];
  const add = (sql: string, ...values: unknown[]) => { conditions.push(sql); params.push(...values); };
  const range = (column: string, value: { from: string | null; to: string | null }) => {
    if (value.from) add(column + " >= ?", new Date(value.from));
    if (value.to) add(column + " <= ?", new Date(value.to));
  };
  if (!f.showOngoing && !f.showFinished) add("1=0");
  else if (!f.showFinished) add("c.is_finished=0");
  else if (!f.showOngoing) add("c.is_finished=1");
  // Finished chats only contribute to unread; do not calculate their interaction/date ordering.
  add(closedUnreadOnly ? "c.is_finished=1" : "c.is_finished=0");
  // Only ongoing, non-bot chats can breach response SLA. Closed unread chats remain in the main counters.
  if (overdueOnly) add("c.is_finished=0 AND (c.bot_id IS NULL OR c.bot_id=0)");
  if (!f.showBots) add("(c.bot_id IS NULL OR c.bot_id=0)");
  if (f.user !== "all") add("c.user_id=?", f.user);
  if (f.showOnlyScheduled) add("c.is_schedule=1");
  range("c.started_at", f.startedAt); range("c.finished_at", f.finishedAt);
  const scheduleFilter = f.scheduledBy !== "all" || f.scheduledFor !== "all" || f.scheduledAt.from || f.scheduledAt.to || f.scheduledTo.from || f.scheduledTo.to;
  if (f.scheduledBy !== "all") add("sch.scheduled_by=?", f.scheduledBy);
  if (f.scheduledFor !== "all") add("sch.scheduled_for=?", f.scheduledFor);
  range("sch.scheduled_at", f.scheduledAt); range("sch.schedule_date", f.scheduledTo);
  const text: string[] = [], textParams: unknown[] = [];
  const match = (column: string, value = f.searchText) => { text.push(column + " LIKE ? ESCAPE '='"); textParams.push(monitorLike(value)); };
  if (f.searchText) {
    if (f.searchColumn === "all" || f.searchColumn === "name") match("c.contact_name");
    if (f.searchColumn === "all" || f.searchColumn === "phone") {
      match("c.contact_phone"); const digits = f.searchText.replace(/\D/g, "");
      if (digits.length >= 3 && digits !== f.searchText) match("c.contact_phone", digits);
    }
    if ((f.searchColumn === "all" || f.searchColumn === "customer") && customerIds.length) {
      text.push("c.customer_id IN (" + customerIds.map(() => "?").join(",") + ")"); textParams.push(...customerIds);
    }
    if (f.searchColumn === "all" || f.searchColumn === "message") match("lm.body");
  }
  const needLatest = f.lastMessageChannelId !== "all" || !!f.searchText && ["all", "message"].includes(f.searchColumn);
  const finalFilters: string[] = [];
  if (f.searchText) finalFilters.push(text.length ? "(" + text.join(" OR ") + ")" : "1=0");
  if (f.lastMessageChannelId !== "all") finalFilters.push("lm.client_id=?");
  // Fixed-width timestamp/id tuple preserves sent_at DESC,id DESC, including NULL dates.
  const messageKey = "CONCAT(IF(m.sent_at IS NULL,'0','1'),COALESCE(DATE_FORMAT(m.sent_at,'%Y%m%d%H%i%s%f'),'00000000000000000000'),LPAD(m.id,20,'0'))";
  const human = "(m.`from` LIKE 'me:%' OR m.`from` LIKE 'user:%') AND m.status IN ('SENT','RECEIVED','READ')";
  const selected = "SELECT DISTINCT c.id,c.instance,c.user_id,c.bot_id,c.is_finished,c.started_at,ct.name AS contact_name,ct.phone AS contact_phone,ct.customer_id FROM chats c LEFT JOIN contacts ct ON ct.id=c.contact_id AND ct.instance=c.instance " +
      (scheduleFilter ? "LEFT JOIN schedules sch ON sch.chat_id=c.id AND sch.instance=c.instance " : "") + "WHERE " + conditions.join(" AND ");
  const selectedParams = [...params];
  if (closedUnreadOnly) {
    const latestJoin = needLatest ? "LEFT JOIN messages lm ON lm.id=(SELECT latest_msg.id FROM messages latest_msg WHERE latest_msg.instance=c.instance AND latest_msg.chat_id=c.id ORDER BY latest_msg.sent_at DESC,latest_msg.id DESC LIMIT 1) AND lm.instance=c.instance " : "";
    if (f.showPendingResponseOnly) finalFilters.push("1=0");
    if (f.searchText) params.push(...textParams);
    if (f.lastMessageChannelId !== "all") params.push(f.lastMessageChannelId);
    const contactJoin = f.searchText && ["all", "name", "phone", "customer"].includes(f.searchColumn) ? "LEFT JOIN contacts ct ON ct.id=c.contact_id AND ct.instance=c.instance " : "";
    const closedFilters = finalFilters.map(value => value.replace(/c\.contact_name/g, "ct.name").replace(/c\.contact_phone/g, "ct.phone").replace(/c\.customer_id/g, "ct.customer_id"));
    const unreadExists = "EXISTS(SELECT 1 FROM messages unread_msg WHERE unread_msg.instance=c.instance AND unread_msg.chat_id=c.id AND unread_msg.status<>'READ' AND (" + inboundSql("unread_msg") + ") LIMIT 1)";
    // Only this tenant-bound historical scan receives the reviewed ten-second ceiling.
    return { sql: "SELECT /*+ MAX_EXECUTION_TIME(10000) */ COUNT(" + (scheduleFilter ? "DISTINCT c.id" : "*") + ") AS unread FROM chats c " + contactJoin + (scheduleFilter ? "LEFT JOIN schedules sch ON sch.chat_id=c.id AND sch.instance=c.instance " : "") + latestJoin + "WHERE " + [...conditions, unreadExists, ...closedFilters].join(" AND "), params };
  }
  const stats = "SELECT m.chat_id,SUM((" + inboundSql("m") + ") AND m.status<>'READ') AS unread_count,MAX(CASE WHEN " + inboundSql("m") + " THEN " + messageKey + " END) AS inbound_key,MAX(CASE WHEN " + human + " THEN " + messageKey + " END) AS human_key" +
      (needLatest ? ",MAX(" + messageKey + ") AS latest_key" : "") +
      " FROM messages m JOIN (" + selected + ") eligible ON eligible.id=m.chat_id AND eligible.instance=m.instance WHERE m.instance=? GROUP BY m.chat_id";
  // Derived tables avoid MySQL prepared-statement reuse of multiply referenced materialized CTEs.
  const classified = "SELECT c.*,COALESCE(ms.unread_count,0) AS unread_count,ms.inbound_key,ms.human_key" + (needLatest ? ",ms.latest_key" : "") +
      ",CASE WHEN c.is_finished=1 THEN 'finished' WHEN COALESCE(c.bot_id,0)<>0 THEN 'in_progress' WHEN c.user_id IS NULL OR c.user_id=0 THEN 'waiting_agent' WHEN ms.inbound_key IS NOT NULL AND (ms.human_key IS NULL OR ms.inbound_key>ms.human_key) THEN 'waiting_agent' WHEN ms.human_key IS NOT NULL THEN 'waiting_customer' ELSE 'in_progress' END AS operational_status FROM (" + selected + ") c LEFT JOIN (" + stats + ") ms ON ms.chat_id=c.id";
  params.push(...selectedParams, session.instance);
  if (f.searchText) params.push(...textParams);
  if (f.lastMessageChannelId !== "all") params.push(f.lastMessageChannelId);
  if (f.showUnreadOnly) finalFilters.push("c.unread_count>0");
  if (f.showPendingResponseOnly) finalFilters.push("c.operational_status='waiting_agent'");
  const latestJoin = needLatest ? "LEFT JOIN messages lm ON lm.id=CAST(RIGHT(c.latest_key,20) AS UNSIGNED) AND lm.instance=c.instance " : "";
  if (!overdueOnly) {
    if (!includeOverdue || slaMinutes === null) return { sql: "SELECT /*+ MAX_EXECUTION_TIME(5000) */ " + totals + ",0 AS overdue,0 AS scheduled FROM (" + classified + ") c " + latestJoin + (finalFilters.length ? "WHERE " + finalFilters.join(" AND ") : ""), params };
    // Keep the eligible/message aggregation once in the statement. Previously the entire
    // classified subtree was executed again for the SLA counter, including all old messages.
    const pending = "SELECT MIN(CAST(pending.timestamp AS UNSIGNED)) FROM messages pending WHERE pending.instance=c.instance AND pending.chat_id=c.id AND (" + inboundSql("pending") + ") AND (responded.id IS NULL OR pending.sent_at>responded.sent_at OR (pending.sent_at=responded.sent_at AND pending.id>responded.id))";
    const waitingSince = "CASE WHEN c.human_key IS NOT NULL AND (c.inbound_key IS NULL OR c.human_key>c.inbound_key) THEN CAST(responded.timestamp AS UNSIGNED) ELSE COALESCE((" + pending + "),TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',c.started_at)/1000) END";
    return { sql: "SELECT /*+ MAX_EXECUTION_TIME(5000) */ " + totals + ",SUM(CASE WHEN c.operational_status='waiting_agent' THEN (" + waitingSince + ")<=" + (now.getTime() - slaMinutes * 60000) + " ELSE 0 END) AS overdue,0 AS scheduled FROM (" + classified + ") c LEFT JOIN messages responded ON responded.id=CAST(RIGHT(c.human_key,20) AS UNSIGNED) AND responded.instance=c.instance " + latestJoin + (finalFilters.length ? "WHERE " + finalFilters.join(" AND ") : ""), params };
  }
  if (slaMinutes === null) throw new Error("SLA_REQUIRED_FOR_OVERDUE_QUERY");
  finalFilters.push("c.operational_status='waiting_agent'");
  return { sql: "SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) AS overdue FROM (SELECT c.id,CASE WHEN c.human_key IS NOT NULL AND (c.inbound_key IS NULL OR c.human_key>c.inbound_key) THEN CAST(responded.timestamp AS UNSIGNED) ELSE COALESCE(MIN(CAST(pending.timestamp AS UNSIGNED)),TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',c.started_at)/1000) END AS waiting_since FROM (" + classified + ") c LEFT JOIN messages responded ON responded.id=CAST(RIGHT(c.human_key,20) AS UNSIGNED) AND responded.instance=c.instance LEFT JOIN messages pending ON pending.instance=c.instance AND pending.chat_id=c.id AND (" + inboundSql("pending") + ") AND (responded.id IS NULL OR pending.sent_at>responded.sent_at OR (pending.sent_at=responded.sent_at AND pending.id>responded.id)) " + latestJoin + "WHERE " + finalFilters.join(" AND ") + " GROUP BY c.id,c.started_at,c.human_key,c.inbound_key,responded.timestamp HAVING waiting_since<=" + (now.getTime() - slaMinutes * 60000) + ") overdue_chats", params };
}

export async function readOptimizedCentralMonitorSummary(context: MonitorQueryContext, execute: SummaryExecute): Promise<MonitorSummary> {
  if (!hasOptimizedCentralScope(context.session) || context.local) throw new Error("MODERN_SUMMARY_SCOPE_REQUIRED");
  const current = { ...context, filters: { ...context.filters, operationalStatus: "all" as const } };
  const f = current.filters;
  const queries: MonitorQuery[] = [];
  if (f.categories.showCustomerChats) {
    if (f.showOngoing) queries.push(buildOptimizedWhatsappSummary(current, false, false, current.slaMinutes !== null));
    if (f.showFinished && !f.showPendingResponseOnly) queries.push(buildOptimizedWhatsappSummary(current, false, true));
  }
  if (f.categories.showInternalChats || f.categories.showInternalGroups) {
    const query = buildMonitorQuery("internal", current);
    queries.push({ sql: "SELECT /*+ MAX_EXECUTION_TIME(5000) */ " + totals + ",SUM(sla_breached=1) AS overdue,SUM(upcoming=1) AS scheduled FROM (" + query.sql + ") monitor_summary", params: query.params });
  }
  if (f.categories.showSchedules) {
    const query = buildMonitorQuery("schedule", current);
    queries.push({ sql: "SELECT /*+ MAX_EXECUTION_TIME(5000) */ " + totals + ",SUM(sla_breached=1) AS overdue,SUM(upcoming=1) AS scheduled FROM (" + query.sql + ") monitor_summary", params: query.params });
  }
  const summary: MonitorSummary = { inProgress: 0, waitingAgent: 0, waitingCustomer: 0, unread: 0, overdue: 0, scheduled: 0, slaMinutes: current.slaMinutes };
  for (const query of queries) {
    const [row] = await execute(query.sql, ...query.params);
    for (const key of keys) summary[key] += Number(row?.[key] ?? 0);
  }
  return summary;
}
