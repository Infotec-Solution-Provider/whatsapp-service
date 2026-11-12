import { ODIM_COPY_ORIGIN, ODIM_COPY_RUN, liveCopyTime } from "./odim-live-copy.core";

type Row = Record<string, any>;
type Execute = (sql: string, values: any[]) => Promise<[any, unknown]>;
type SourceQuery = (sql: string, values: any[]) => Promise<Row[]>;
export interface OdimReadChange { id: number; chatId: number; contactId: number; }

const ENTITY = "odim-live-copy-v1/";
const BATCH = 50;
const ID_WINDOW = 25_000;
const COOLDOWN_MS = 10_000;
const ERROR_COOLDOWN_MS = 60_000;
const INBOUND = "`from` NOT LIKE 'me:%' AND `from` NOT LIKE 'user:%' AND `from` NOT LIKE 'system%' AND `from` NOT LIKE 'bot%' AND `from` NOT LIKE 'thirdparty%'";
const ELIGIBLE = "status IN ('SENT','RECEIVED','DOWNLOADED')";

function sourceId(maps: Row[], domain: string, target: number): number | null {
 const rows = maps.filter(row => row["entity"] === ENTITY + domain && Number(row["target_id"]) === target);
 if (rows.length !== 1) return null;
 const value = String(rows[0]!["source_id"]);
 if (!value.startsWith(ODIM_COPY_ORIGIN)) return null;
 const suffix = value.slice(ODIM_COPY_ORIGIN.length);
 const id = Number(suffix);
 return /^\d+$/.test(suffix) && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Independent, bounded reconciliation of copied inbound receipts. Never writes to the legacy CRM. */
export class OdimCopyReadReconciler {
 public running = false;
 public readonly health = {
  lastRunAt: null as string | null, cursor: 0, checked: 0, confirmed: 0, updated: 0,
  totalChecked: 0, totalUpdated: 0, cycles: 0, lastError: null as string | null,
 };
 private nextAt = 0;
 private ceiling = 0;
 constructor(
  private readonly execute: Execute,
  private readonly source: SourceQuery,
  private readonly notify: (change: OdimReadChange) => Promise<unknown>,
 ) {}

 public async run(now = Date.now()): Promise<void> {
  if (this.running || now < this.nextAt) return;
  this.running = true;
  this.nextAt = now + COOLDOWN_MS;
  this.health.lastRunAt = new Date(now).toISOString();
  this.health.checked = this.health.confirmed = this.health.updated = 0;
  try {
   await this.scan();
   this.health.lastError = null;
  } catch {
   // A source timeout or failed conditional write must never stop the primary copy loop.
   this.health.lastError = "READ_RECONCILIATION_RETRY_PENDING";
   this.nextAt = now + ERROR_COOLDOWN_MS;
  } finally { this.running = false; }
 }

 private async scan(): Promise<void> {
  if (this.health.cursor >= this.ceiling) {
   const [first] = await this.execute("SELECT /*+ MAX_EXECUTION_TIME(4000) */ target_id FROM instance_migration_maps WHERE run_id=? AND instance='odim' AND entity=? AND target_id IS NOT NULL ORDER BY target_id ASC LIMIT 1", [ODIM_COPY_RUN, ENTITY + "messages"]);
   const [last] = await this.execute("SELECT /*+ MAX_EXECUTION_TIME(4000) */ target_id FROM instance_migration_maps WHERE run_id=? AND instance='odim' AND entity=? AND target_id IS NOT NULL ORDER BY target_id DESC LIMIT 1", [ODIM_COPY_RUN, ENTITY + "messages"]);
   if (!first.length || !last.length) return;
   const floor = Number(first[0].target_id), ceiling = Number(last[0].target_id);
   if (!Number.isSafeInteger(floor) || !Number.isSafeInteger(ceiling) || floor < 1 || ceiling < floor) throw Error("INVALID_COPY_READ_RANGE");
   this.health.cursor = floor - 1;
   this.ceiling = ceiling;
   this.health.cycles++;
  }
  const end = Math.min(this.health.cursor + ID_WINDOW, this.ceiling);
  const [candidates]: [Row[], unknown] = await this.execute(
   `SELECT /*+ MAX_EXECUTION_TIME(4000) */ id,chat_id,contact_id,status,timestamp,\`from\`,\`to\` FROM messages WHERE id>? AND id<=? AND instance='odim' AND chat_id IS NOT NULL AND contact_id IS NOT NULL AND ${ELIGIBLE} AND ${INBOUND} ORDER BY id LIMIT ${BATCH}`,
   [this.health.cursor, end],
  );
  this.health.checked = candidates.length;
  this.health.totalChecked += candidates.length;
  const maps: Row[] = [];
  for (const [domain, column] of [["messages", "id"], ["chats", "chat_id"], ["contacts", "contact_id"]] as const) {
   const ids = [...new Set(candidates.map(row => Number(row[column])))];
   if (!ids.length) continue;
   const [rows] = await this.execute(`SELECT /*+ MAX_EXECUTION_TIME(4000) */ entity,MIN(source_id) AS source_id,target_id FROM instance_migration_maps WHERE run_id=? AND instance='odim' AND entity=? AND target_id IN (${ids.map(() => "?").join(",")}) GROUP BY entity,target_id HAVING COUNT(*)=1 LIMIT ${BATCH}`, [ODIM_COPY_RUN, ENTITY + domain, ...ids]);
   maps.push(...rows);
  }
  const linked = candidates.flatMap(message => {
   const id = sourceId(maps, "messages", Number(message["id"]));
   const chat = sourceId(maps, "chats", Number(message["chat_id"]));
   const contact = sourceId(maps, "contacts", Number(message["contact_id"]));
   return id && chat && contact ? [{ message, id, chat, contact }] : [];
  });
  const ids = [...new Set(linked.map(item => item.id))];
  const observed = ids.length ? await this.source(`SELECT CODIGO,CODIGO_ATENDIMENTO,CODIGO_NUMERO,FROM_ME,TIMESTAMP,STATUS FROM w_mensagens WHERE CODIGO IN (${ids.map(() => "?").join(",")}) LIMIT ${BATCH}`, ids) : [];
  const changed: OdimReadChange[] = [];
  for (const item of linked) {
   const matches = observed.filter(row => Number(row["CODIGO"]) === item.id);
   if (matches.length !== 1) continue;
   const row = matches[0]!;
   if (String(row["FROM_ME"]) !== "0" || !["READ", "PLAYED"].includes(row["STATUS"]) || Number(row["CODIGO_ATENDIMENTO"]) !== item.chat || Number(row["CODIGO_NUMERO"]) !== item.contact) continue;
   let timestamp: string;
   try { timestamp = liveCopyTime(row).timestamp; } catch { continue; }
   if (timestamp !== String(item.message["timestamp"])) continue;
   this.health.confirmed++;
   const m = item.message;
   // Recheck all identity links and the exact observed state in the same atomic UPDATE.
   const proofs = [["messages", item.id, m["id"]], ["chats", item.chat, m["chat_id"]], ["contacts", item.contact, m["contact_id"]]] as const;
   const [result] = await this.execute(
    `UPDATE messages SET status='READ' WHERE id=? AND instance='odim' AND chat_id=? AND contact_id=? AND status=? AND timestamp=? AND \`from\`=? AND \`to\`=? AND ${ELIGIBLE} AND ${INBOUND} AND ${proofs.map(() => "EXISTS (SELECT 1 FROM instance_migration_maps p WHERE p.run_id=? AND p.instance='odim' AND p.entity=? AND p.source_id=? AND p.target_id=?)").join(" AND ")}`,
    [m["id"], m["chat_id"], m["contact_id"], m["status"], m["timestamp"], m["from"], m["to"], ...proofs.flatMap(([domain, source, target]) => [ODIM_COPY_RUN, ENTITY + domain, ODIM_COPY_ORIGIN + source, target])],
   );
   if (Number(result.affectedRows) !== 1) continue;
   this.health.updated++;
   this.health.totalUpdated++;
   changed.push({ id: Number(m["id"]), chatId: Number(m["chat_id"]), contactId: Number(m["contact_id"]) });
  }
  this.health.cursor = candidates.length === BATCH ? Number(candidates.at(-1)!["id"]) : end;
  // The existing UPDATE trigger already published the durable journal. Bound optional hints to
  // this single batch and send together so a failed socket costs one timeout, not 50 timeouts.
  await Promise.allSettled(changed.map(change => Promise.resolve().then(() => this.notify(change))));
 }
}
