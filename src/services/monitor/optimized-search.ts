import { UnauthorizedError } from "@rgranatodutra/http-errors";
import type { MonitorCategory, MonitorFilters, MonitorRequest } from "./monitor-contract";
import { buildMonitorQuery, inboundSql, monitorLike, monitorOrder, type MonitorQuery, type MonitorQueryContext } from "./optimized-query";
import { hasOptimizedCentralScope } from "./optimized-access";
import type { MonitorRow } from "./monitor-reader";
export type SearchExecute = (sql: string, ...params: unknown[]) => Promise<MonitorRow[]>;

const fields = "id,category,started_at,finished_at,schedule_date,contact_name,group_name,operational_status,unread_count,lm_at,waiting_since,sla_breached,upcoming";
const epoch = (column: string) => `TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',${column})/1000`;
const deadline = "SELECT /*+ MAX_EXECUTION_TIME(5000) */ ";
const hasScheduleFilters = (f: MonitorFilters) => f.scheduledBy !== "all" || f.scheduledFor !== "all" || !!(f.scheduledAt.from || f.scheduledAt.to || f.scheduledTo.from || f.scheduledTo.to);

// Production lacks the schema's intended UNIQUE(chat_id). A matching chat is still one item;
// its displayed schedule is the latest matching link, rather than an arbitrary duplicate.
function deduplicateSchedules(query: MonitorQuery): MonitorQuery {
  return { sql: "SELECT * FROM (SELECT matched.*,ROW_NUMBER() OVER(PARTITION BY id ORDER BY scheduled_at DESC,schedule_id DESC) AS schedule_rank FROM (" + query.sql + ") matched) unique_schedule WHERE schedule_rank=1", params: query.params };
}

function openCandidates(context: MonitorQueryContext): MonitorQuery {
  const query = restrict(buildMonitorQuery("wpp", context, "page"), "c.is_finished=0");
  return hasScheduleFilters(context.filters) || context.filters.sortBy === "scheduledAt" ? deduplicateSchedules(query) : query;
}

/** Restrict the builder's owning table before any latest-message/SLA lookups, never after paging. */
function restrict(query: MonitorQuery, predicate: string, values: unknown[] = []): MonitorQuery {
  const anchor = "WHERE c.instance = ?";
  if (query.sql.split(anchor).length !== 2) throw new Error("MONITOR_SCOPE_ANCHOR_CHANGED");
  return { sql: query.sql.replace(anchor, anchor + " AND " + predicate), params: [query.params[0], ...values, ...query.params.slice(1)] };
}

/** Minimal owning-table filters. Latest refers to the final message, before any channel/text predicate. */
function whatsappBase(context: MonitorQueryContext, finished: boolean, latest: boolean, forCount = false): MonitorQuery & { hasSchedule: boolean } {
  const { filters: f, customerIds } = context;
  const clauses = ["c.instance=?", "c.is_finished=?"], params: unknown[] = [context.session.instance, finished ? 1 : 0];
  const add = (sql: string, ...values: unknown[]) => { clauses.push(sql); params.push(...values); };
  const range = (column: string, input: { from: string | null; to: string | null }) => {
    if (input.from) add(column + ">=?", new Date(input.from));
    if (input.to) add(column + "<=?", new Date(input.to));
  };
  if (!f.showBots) add("(c.bot_id IS NULL OR c.bot_id IN (0,-10))");
  if (f.user !== "all") add("c.user_id=?", f.user);
  if (f.showOnlyScheduled) add("c.is_schedule=1");
  range("c.started_at", f.startedAt); range("c.finished_at", f.finishedAt);
  if (f.scheduledBy !== "all") add("sch.scheduled_by=?", f.scheduledBy);
  if (f.scheduledFor !== "all") add("sch.scheduled_for=?", f.scheduledFor);
  range("sch.scheduled_at", f.scheduledAt); range("sch.schedule_date", f.scheduledTo);
  if (f.lastMessageChannelId !== "all") add("lm.client_id=?", f.lastMessageChannelId);
  if (f.searchText) {
    const matches: string[] = [], values: unknown[] = [];
    const like = (column: string, value = f.searchText) => { matches.push(column + " LIKE ? ESCAPE '='"); values.push(monitorLike(value)); };
    if (["all", "name"].includes(f.searchColumn)) like("ct.name");
    if (["all", "phone"].includes(f.searchColumn)) {
      like("ct.phone"); const digits = f.searchText.replace(/\D/g, "");
      if (digits.length >= 3 && digits !== f.searchText) like("ct.phone", digits);
    }
    if (["all", "customer"].includes(f.searchColumn) && customerIds.length) {
      matches.push("ct.customer_id IN (" + customerIds.map(() => "?").join(",") + ")"); values.push(...customerIds);
    }
    if (["all", "message"].includes(f.searchColumn)) like("lm.body");
    add(matches.length ? "(" + matches.join(" OR ") + ")" : "1=0", ...values);
  }
  const hasSchedule = hasScheduleFilters(f) || !forCount && f.sortBy === "scheduledAt";
  const joins = " FROM chats c LEFT JOIN contacts ct ON ct.id=c.contact_id AND ct.instance=c.instance " +
    (hasSchedule ? "LEFT JOIN schedules sch ON sch.chat_id=c.id AND sch.instance=c.instance " : "") +
    (latest ? "LEFT JOIN messages lm ON lm.id=(SELECT final_message.id FROM messages final_message WHERE final_message.instance=c.instance AND final_message.chat_id=c.id ORDER BY final_message.sent_at DESC,final_message.id DESC LIMIT 1) AND lm.instance=c.instance " : "");
  return { sql: joins + "WHERE " + clauses.join(" AND "), params, hasSchedule };
}

function needsLatestFilter(f: MonitorFilters) { return f.lastMessageChannelId !== "all" || !!f.searchText && ["all", "message"].includes(f.searchColumn); }
function closedAllowed(f: MonitorFilters) { return f.showFinished && !f.showPendingResponseOnly && ["all", "unread"].includes(f.operationalStatus); }

/** Closed chats are always finished: skip interaction, pending and outgoing scans over the full archive. */
export function buildOptimizedClosedSearch(context: MonitorQueryContext, forCount = false, readOnly = false, unreadIds?: number[]): MonitorQuery {
  const f = context.filters;
  if (!forCount && !readOnly && f.sortBy === "urgency" && !f.showUnreadOnly && f.operationalStatus !== "unread") {
    const unread = buildOptimizedClosedSearch({ ...context, filters: { ...f, showUnreadOnly: true } }, false, false, unreadIds);
    const read = buildOptimizedClosedSearch(context, false, true, unreadIds);
    return { sql: unread.sql + " UNION ALL " + read.sql, params: [...unread.params, ...read.params] };
  }
  const latest = needsLatestFilter(f) || !forCount && ["urgency", "lastMessage"].includes(f.sortBy);
  const unreadNeeded = f.showUnreadOnly || f.operationalStatus === "unread" || !forCount && f.sortBy === "urgency";
  const unreadFilter = f.showUnreadOnly || f.operationalStatus === "unread";
  const base = whatsappBase(context, true, latest, forCount);
  const existsUnread = unreadIds === undefined ? "EXISTS(SELECT 1 FROM messages unread_message WHERE unread_message.instance=c.instance AND unread_message.chat_id=c.id AND unread_message.status<>'READ' AND (" + inboundSql("unread_message") + "))" : unreadIds.length ? "c.id IN (SELECT known_unread.id FROM JSON_TABLE(?, '$[*]' COLUMNS(id INT PATH '$')) known_unread)" : "0";
  // Keep the unread predicate directly on the owning table so MySQL can use a FirstMatch
  // semi-join. Alias filtering would repeat its correlated scan during sort/projection.
  const unread = readOnly ? "0" : unreadFilter ? "1" : unreadNeeded ? existsUnread : "0";
  const projection = `c.id,'wpp' AS category,${epoch("c.started_at")} AS started_at,${epoch("c.finished_at")} AS finished_at,${base.hasSchedule ? epoch("sch.schedule_date") : "NULL"} AS schedule_date,${base.hasSchedule ? epoch("sch.scheduled_at") : "NULL"} AS scheduled_at,${base.hasSchedule ? "sch.id" : "NULL"} AS schedule_id,ct.name AS contact_name,NULL AS group_name,'finished' AS operational_status,${unread} AS unread_count,${latest ? "CAST(lm.timestamp AS UNSIGNED)" : "NULL"} AS lm_at,NULL AS waiting_since,0 AS sla_breached,0 AS upcoming`;
  const selected = "SELECT " + projection + base.sql + (readOnly ? " AND NOT " + existsUnread : unreadFilter ? " AND " + existsUnread : "");
  const filtered = { sql: "SELECT * FROM (" + selected + ") closed_candidates", params: [...base.params, ...(unreadIds?.length && (readOnly || unreadFilter) ? [JSON.stringify(unreadIds)] : [])] };
  return base.hasSchedule && !forCount ? deduplicateSchedules(filtered) : filtered;
}

interface SearchSource { category: MonitorCategory; closed: boolean; page: MonitorQuery; count: MonitorQuery }
function sourceQueries(context: MonitorQueryContext): SearchSource[] {
  const f = context.filters, sources: SearchSource[] = [];
  if (f.categories.showCustomerChats) {
    for (const closed of [false, true]) {
      if (closed ? !closedAllowed(f) : !f.showOngoing) continue;
      const full = closed ? buildOptimizedClosedSearch(context) : openCandidates(context);
      const needsFacts = f.showUnreadOnly || f.showPendingResponseOnly || f.operationalStatus !== "all";
      const count = closed && needsFacts ? buildOptimizedClosedSearch(context, true)
        : restrict(buildMonitorQuery("wpp", context, "count"), closed ? "c.is_finished=1" : "c.is_finished=0");
      sources.push({ category: "wpp", closed, page: { sql: "SELECT " + fields + " FROM (" + full.sql + ") candidates", params: full.params }, count });
    }
  }
  for (const category of ["internal", "schedule"] as const) {
    if (category === "internal" ? !f.categories.showInternalChats && !f.categories.showInternalGroups : !f.categories.showSchedules) continue;
    const query = buildMonitorQuery(category, context, "page");
    sources.push({ category, closed: false, page: { sql: "SELECT " + fields + " FROM (" + query.sql + ") candidates", params: query.params }, count: buildMonitorQuery(category, context, "count") });
  }
  return sources;
}

function union(sources: SearchSource[]) { return { sql: sources.map(source => source.page.sql).join(" UNION ALL "), params: sources.flatMap(source => source.page.params) }; }
async function candidatePage(context: MonitorQueryContext, request: MonitorRequest, sources: SearchSource[], execute: SearchExecute) {
  if (!sources.length) return [];
  const query = union(sources), order = monitorOrder(context.filters);
  const pageDeadline = sources.some(source => source.closed) ? "SELECT /*+ MAX_EXECUTION_TIME(10000) */ /* archive_monitor_page */ " : deadline;
  return execute(pageDeadline + "monitor_rows.*, " + order.projection + " FROM (" + query.sql + ") monitor_rows ORDER BY " + order.order + " LIMIT ? OFFSET ?", ...query.params, request.pageSize, (request.page - 1) * request.pageSize);
}

/** Counts include every selected category; only a proven high-priority prefix may bypass closed-page scans. */
export async function readOptimizedCentralMonitorSearch(context: MonitorQueryContext, request: MonitorRequest, execute: SearchExecute) {
  if (!hasOptimizedCentralScope(context.session) || context.local) throw new UnauthorizedError("Modern monitor scope unavailable");
  const sources = sourceQueries(context), nonempty: SearchSource[] = [];
  let unreadIds: number[] | undefined;
  const loadClosedUnreadIds = async () => {
    if (unreadIds) return unreadIds;
    const query = whatsappBase(context, true, needsLatestFilter(context.filters), true);
    const noContactFilter = !context.filters.searchText || context.filters.searchColumn === "message";
    const base = noContactFilter ? query.sql.replace("LEFT JOIN contacts ct ON ct.id=c.contact_id AND ct.instance=c.instance ", "") : query.sql;
    // This exact historical metadata read gets10s after measured I/O exceeded5s.
    // Other live/count/hydration reads stay at5s; archive pages also get10s when needed.
    const ids = await execute("SELECT /*+ MAX_EXECUTION_TIME(10000) */ " + (query.hasSchedule ? "DISTINCT " : "") + "c.id" + base + " AND EXISTS(SELECT 1 FROM messages unread_message WHERE unread_message.instance=c.instance AND unread_message.chat_id=c.id AND unread_message.status<>'READ' AND (" + inboundSql("unread_message") + ")) /* unread_chat_ids */", ...query.params);
    unreadIds = [...new Set(ids.map(row => Number(row["id"])))];
    if (unreadIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("INVALID_UNREAD_CHAT_ID");
    return unreadIds;
  };
  let totalCount = 0;
  for (const source of sources) {
    let count: number;
    if (source.closed && (context.filters.showUnreadOnly || context.filters.operationalStatus === "unread")) count = (await loadClosedUnreadIds()).length;
    else {
      const [row] = await execute(deadline + "COUNT(DISTINCT id) AS total FROM (" + source.count.sql + ") monitor_count", ...source.count.params);
      count = Number(row?.["total"] ?? 0);
    }
    totalCount += count;
    if (count) nonempty.push(source);
  }
  const pagination = { totalCount, page: request.page, pageSize: request.pageSize };
  if ((request.page - 1) * request.pageSize >= totalCount) return { ...pagination, rows: [] as MonitorRow[] };
  let candidates: MonitorRow[] | undefined;
  if (context.filters.sortBy === "urgency" && context.filters.sortOrder === "desc" && nonempty.some(source => source.closed)) {
    const prefix = await candidatePage(context, request, nonempty.filter(source => !source.closed), execute);
    // Closed rows have priority at most2. Include them whenever the page crosses that boundary.
    if (prefix.length === request.pageSize && Number(prefix.at(-1)?.["sort_priority"]) >= 3) candidates = prefix;
  }
  if (!candidates) {
    const needUnreadSet = context.filters.sortBy === "urgency" || context.filters.showUnreadOnly || context.filters.operationalStatus === "unread";
    const ids = needUnreadSet && nonempty.some(source => source.closed) ? await loadClosedUnreadIds() : undefined;
    const ready = nonempty.map(source => {
      if (!source.closed || ids === undefined) return source;
      const query = buildOptimizedClosedSearch(context, false, false, ids);
      return { ...source, page: { sql: "SELECT " + fields + " FROM (" + query.sql + ") candidates", params: query.params } };
    });
    candidates = await candidatePage(context, request, ready, execute);
  }
  const hydrated = new Map<string, MonitorRow>();
  for (const category of ["wpp", "internal", "schedule"] as const) {
    const ids = candidates.filter(row => row["category"] === category).map(row => Number(row["id"]));
    if (!ids.length) continue;
    const scoped = restrict(buildMonitorQuery(category, context), "c.id IN (" + ids.map(() => "?").join(",") + ")", ids);
    const query = category === "wpp" ? deduplicateSchedules(scoped) : scoped;
    for (const row of await execute(deadline + "* FROM (" + query.sql + ") page_details", ...query.params)) hydrated.set(String(row["category"]) + ":" + row["id"], row);
  }
  return { ...pagination, rows: candidates.flatMap(row => { const detail = hydrated.get(String(row["category"]) + ":" + row["id"]); return detail ? [detail] : []; }) };
}

