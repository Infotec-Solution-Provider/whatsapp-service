import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { MonitorFilters } from "./monitor-contract";

export type MonitorMeasure = <T>(stage: string, read: () => Promise<T>) => Promise<T>;

/** Elapsed application/pool time; never claims to measure server execution or logs SQL/arguments. */
export async function observeMonitorRead<T>(instance: string, operation: "search" | "summary", filters: MonitorFilters,
  read: (measure: MonitorMeasure) => Promise<T>, report: (entry: Record<string, unknown>) => void = entry => process.stderr.write(`[monitor-query] ${JSON.stringify(entry)}\n`)): Promise<T> {
  const start = performance.now(), stages = new Map<string, { calls: number; durationMs: number; rows: number; failed: number }>();
  // A query signature must not retain customer names, phone numbers, documents or message text.
  const filterSignature = createHash("sha256").update(JSON.stringify({ ...filters, searchText: { length: filters.searchText.length } })).digest("hex").slice(0, 16);
  let code: string | null = null, failed = false;
  const errorCode = (error: unknown) => {
    const candidate = error && typeof error === "object" && "code" in error ? error.code : null;
    return typeof candidate === "string" && /^[A-Z0-9_]{1,40}$/.test(candidate) ? candidate : "UNKNOWN";
  };
  const measure: MonitorMeasure = async (stage, query) => {
    const started = performance.now(), entry = stages.get(stage) ?? { calls: 0, durationMs: 0, rows: 0, failed: 0 };
    stages.set(stage, entry); entry.calls++;
    try { const result = await query(); if (Array.isArray(result)) entry.rows += result.length; return result; }
    catch (error) {
      entry.failed++;
      code = errorCode(error);
      throw error;
    } finally { entry.durationMs += Math.round(performance.now() - started); }
  };
  try { return await read(measure); }
  catch (error) { failed = true; code ??= errorCode(error); throw error; }
  finally {
    try { report({ requestId: randomUUID(), instance, operation, filterSignature, searchLength: filters.searchText.length,
      elapsedMs: Math.round(performance.now() - start), failed, code, stages: Object.fromEntries(stages) }); }
    catch { /* Observability cannot change the result of a read. */ }
  }
}

export function monitorQueryStage(sql: string): string {
  if (sql.includes("unread_chat_ids")) return "closedUnread";
  if (sql.includes("monitor_count")) return "count";
  if (sql.includes("page_details")) return "details";
  if (sql.includes("monitor_rows")) return "page";
  return "enrichment";
}
