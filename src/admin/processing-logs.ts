import logs from "../logs/service";
import { AdminCommand, AdminProtocolError } from "./admin-protocol";
import { secretKey } from "./settings-utils";

export function redactLog(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[limite]";
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactLog(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey(key) ? "[sigilo]" : redactLog(item, depth + 1)]));
  if (typeof value !== "string") return value;
  if (value.length < 32000 && /^[\[{]/.test(value.trim())) { try { return redactLog(JSON.parse(value), depth + 1); } catch { /* plain log text */ } }
	return value.slice(0, 12000)
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, "[sigilo]")
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9+/_=.~-]+/gi, "$1[sigilo]")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|EAA[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[sigilo]")
    .replace(/((?:password|passwd|senha|secret|token|authorization|api[_-]?key|SIP_KEY|credential)\s*["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/gi, "$1[sigilo]")
    .replace(/((?:mysql|postgres(?:ql)?|redis|https?):\/\/[^\s/:@]+:)[^\s@]+@/gi, "$1[sigilo]@");
}
export function processingLogTimestamp(value: unknown): string {
  // mysql2 dateStrings returns a SQL DATETIME without a timezone. The log
  // writer stores UTC and the managed connection enforces time_zone='+00:00'.
  const text = typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value)
    ? `${value.replace(" ", "T")}Z` : value;
  const date = text instanceof Date ? text : new Date(String(text));
  if (!Number.isFinite(date.getTime())) throw new AdminProtocolError(503, "Data do registro de processamento inválida.");
  return date.toISOString();
}
export async function processingLogs(command: AdminCommand) {
  if (typeof command.tenant !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(command.tenant)) throw new AdminProtocolError(400, "Selecione o tenant dos logs de processamento.");
  const to = command.to ? new Date(command.to) : new Date(), from = command.from ? new Date(command.from) : new Date(to.getTime() - 86400000);
  if (!Number.isFinite(to.getTime()) || !Number.isFinite(from.getTime()) || from > to || to.getTime() - from.getTime() > 31 * 86400000) throw new AdminProtocolError(400, "Selecione um intervalo de até 31 dias.");
  const search = command.search ?? "", identifier = command.identifier ?? "";
  if (search.length > 200 || identifier.length > 100 || command.cursor && !/^[1-9]\d{0,18}$/.test(command.cursor)) throw new AdminProtocolError(400, "Filtro de logs inválido.");
  const limit = Math.min(command.limit ?? 200, 200), clauses = ["created_at>=?", "created_at<=?"], params: unknown[] = [from, to];
  clauses.push("instance=?"); params.push(command.tenant);
  if (command.cursor) { clauses.push("id<?"); params.push(command.cursor); }
  if (command.level) { clauses.push("status=?"); params.push(["error", "failed", "FAILED"].includes(command.level) ? "FAILED" : "SUCCESS"); }
  if (identifier) { clauses.push("(process_id=? OR CAST(id AS CHAR)=?)"); params.push(identifier, identifier); }
  if (search) { clauses.push("(LOCATE(?,process_name)>0 OR LOCATE(?,error_message)>0 OR LOCATE(?,log_entries)>0)"); params.push(search, search, search); }
  // mysql2 3.x binds JS numbers as DOUBLE, rejected by some MySQL8 versions
  // for a prepared LIMIT. A validated decimal string binds the integer safely.
  params.push(String(limit + 1));
  const rows = await logs.readAdminPage(`SELECT id,instance,process_name,process_id,status,duration,created_at,LEFT(error_message,4000) AS error_message,LEFT(log_entries,12000) AS log_entries FROM process_logs WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`, params);
  const selected = rows.slice(0, limit);
  return { entries: selected.map(row => ({ id: String(row["id"]), timestamp: processingLogTimestamp(row["created_at"]), service: "whatsapp", tenant: String(row["instance"]), level: row["status"] === "FAILED" ? "error" : "info", message: JSON.stringify(redactLog({ process: row["process_name"], identifier: row["process_id"], status: row["status"], duration: row["duration"], error: row["error_message"], entries: row["log_entries"] })).slice(0, 16000) })), ...(rows.length > limit ? { nextCursor: String(selected.at(-1)!["id"]) } : {}), truncated: rows.length > limit };
}
