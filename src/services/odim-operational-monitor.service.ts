import { BadRequestError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local";
import db from "./prisma.service";
import instances from "./instances.service";
/** Paged reads against the copied operational model; never reads the legacy archive. */
export async function searchOdimOperationalMonitor(session: SessionData, input: { page?: number; pageSize?: number; filters?: Record<string, any> }) {
 if (session.instance !== "odim" || session.role !== "ADMIN") throw new BadRequestError("Invalid copy scope");
 const page = Number(input.page || 1), limit = Number(input.pageSize || 20), f = input.filters || {};
 if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestError("Invalid page");
 const where = ["chat.instance='odim'"], values: unknown[] = [];
 const ongoing = f["showOngoing"] !== false, finished = f["showFinished"] !== false;
 if (f["categories"]?.showCustomerChats === false || (!ongoing && !finished)) return { items: [], totalCount: 0 };
 if (ongoing !== finished) { where.push("chat.is_finished=?"); values.push(ongoing ? 0 : 1); }
 if (f["user"] && f["user"] !== "all") { const id = Number(f["user"]); if (!Number.isSafeInteger(id)) throw new BadRequestError("Invalid user"); where.push("chat.user_id=?"); values.push(id); }
 if (!f["showBots"]) where.push("(chat.bot_id IS NULL OR chat.bot_id=0)");
 if (f["showOnlyScheduled"]) where.push("chat.is_schedule=1");
 for (const [field, column] of [["startedAt", "started_at"], ["finishedAt", "finished_at"]] as const) for (const [bound, op] of [["from", ">="], ["to", "<="]] as const) {
  if (f[field]?.[bound]) { const date = new Date(f[field][bound]); if (Number.isNaN(date.getTime())) throw new BadRequestError("Invalid date"); where.push(`chat.${column}${op}?`); values.push(date); }
 }
 const search = String(f["searchText"] || "").trim().slice(0, 100), column = String(f["searchColumn"] || "all");
 if (search) {
  const like = "%" + search.replace(/[!%_]/g, c => "!" + c) + "%", clauses = [];
  if (column === "name" || column === "all") { clauses.push("c.name LIKE ? ESCAPE '!'"); values.push(like); }
  if (column === "phone" || column === "all") { clauses.push("(c.phone LIKE ? ESCAPE '!' OR c.whatsapp_id LIKE ? ESCAPE '!')"); values.push(like, like); }
  if (column === "message" || column === "all") { clauses.push("EXISTS(SELECT 1 FROM messages m WHERE m.instance='odim' AND m.chat_id=chat.id AND m.body LIKE ? ESCAPE '!')"); values.push(like); }
  if (column === "customer" || column === "all") {
   const customers = await instances.executeQuery<{ CODIGO: number }[]>("odim", "SELECT CODIGO FROM clientes WHERE RAZAO LIKE ? OR FANTASIA LIKE ? OR CPF_CNPJ LIKE ? LIMIT 100", ["%" + search + "%", "%" + search + "%", "%" + search + "%"]);
   if (customers.length) { clauses.push(`c.customer_id IN (${customers.map(() => "?").join(",")})`); values.push(...customers.map(c => c.CODIGO)); }
  }
  where.push(clauses.length ? "(" + clauses.join(" OR ") + ")" : "FALSE");
 }
 if (f["showUnreadOnly"]) where.push("EXISTS(SELECT 1 FROM messages u WHERE u.instance='odim' AND u.contact_id=chat.contact_id AND u.status<>'READ' AND u.`from` NOT LIKE 'me:%' AND u.`from` NOT LIKE 'system%' AND u.`from` NOT LIKE 'bot%' AND u.`from` NOT LIKE 'thirdparty%' AND u.`from` NOT LIKE 'user:%')");
 if (f["showPendingResponseOnly"]) where.push("(SELECT p.`from` FROM messages p WHERE p.instance='odim' AND p.contact_id=chat.contact_id ORDER BY p.sent_at DESC,p.id DESC LIMIT 1) NOT LIKE 'me:%'");
 const base = " FROM chats chat LEFT JOIN contacts c ON c.id=chat.contact_id AND c.instance='odim' WHERE " + where.join(" AND ");
 const direction = f["sortOrder"] === "asc" ? "ASC" : "DESC";
 let order = "chat.id";
 if (f["sortBy"] === "name") order = "c.name";
 if (f["sortBy"] === "lastMessage") order = "(SELECT MAX(l.sent_at) FROM messages l WHERE l.instance='odim' AND l.contact_id=chat.contact_id)";
 const count = await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) n" + base, ...values);
 const ids = await db.$queryRawUnsafe<{ id: number }[]>("SELECT /*+ MAX_EXECUTION_TIME(5000) */ chat.id" + base + ` ORDER BY ${order} ${direction},chat.id ${direction} LIMIT ? OFFSET ?`, ...values, limit, (page - 1) * limit);
 const chats = await db.wppChat.findMany({ where: { instance: "odim", id: { in: ids.map(r => r.id) } }, include: { contact: true, schedule: true } });
 const customers = [...new Set(chats.flatMap(c => c.contact?.customerId && c.contact.customerId > 0 ? [c.contact.customerId] : []))];
 const crm = customers.length ? await instances.executeQuery<any[]>("odim", "SELECT CODIGO,RAZAO,FANTASIA,CPF_CNPJ,COD_ERP FROM clientes WHERE CODIGO IN (?)", [customers]) : [];
 const items = await Promise.all(ids.map(async ({ id }) => {
  const chat = chats.find(c => c.id === id)!;
  const lastMessage = chat.contactId ? await db.wppMessage.findFirst({ where: { instance: "odim", contactId: chat.contactId }, orderBy: [{ sentAt: "desc" }, { id: "desc" }] }) : null;
  return { ...chat, chatType: "wpp", customer: crm.find(c => c.CODIGO === chat.contact?.customerId) || null, lastMessage, isUnread: !!lastMessage && lastMessage.status !== "READ" && !/^(me:|system|bot|thirdparty|user:)/.test(lastMessage.from) };
 }));
 return { items, totalCount: Number(count[0]?.n || 0) };
}
