import "dotenv/config";
import { createServer } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { InstancesClient, SocketServerClient, SocketEventType } from "../sdk-local";
import { OdimLiveCopyWriter, ODIM_COPY_RUN } from "../services/odim-live-copy.core";
import { createOdimCopyIngress } from "../services/odim-live-copy.ingress";
import { odimMirrorSourceId, odimReactionSnapshot, processOdimMirrorWebhook, type OdimMirrorReactionChange } from "../services/odim-copy-reactions";
import { readOdimAccessOnlyProfile, odimAccessOnlyProfilePath } from "../utils/odim-access-only";
import { OdimCopyReadReconciler } from "../services/odim-copy-read-reconciliation";
const source = new InstancesClient("http://127.0.0.1:8000"), socket = new SocketServerClient("http://127.0.0.1:8004");
const SNAP = "d60d646d-a75b-db65-c5fa-eb346177f2e7";
let stopping = false, busy = false, sourceVerified = false, lastError: string | null = null, lastSyncAt: string | null = null, loops = 0, config: any, db: mysql.Connection, pool: mysql.Pool;
let readReconciliation: OdimCopyReadReconciler | undefined;
const safe = (b: unknown, code: string) => { if (!b) throw Error(code); };
const querySource = (sql: string, values: any[] = []) => source.executeQuery<any[]>("odim", sql, values);
function keyConfig() {
 const file = resolve(__dirname, "../../config/odim-history-mirror.json"), stat = lstatSync(file); safe(stat.isFile() && !stat.isSymbolicLink() && stat.size < 4096 && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(), "PRIVATE_CONFIG_REQUIRED");
 const c = JSON.parse(readFileSync(file, "utf8")); safe(c.enabled === true && c.instance === "odim" && /^[a-f0-9]{64}$/.test(c.key), "EXPLICIT_MIRROR_CONFIG_REQUIRED"); return c.key as string;
}
async function featureEnabled() { const [rows] = await db.execute<any[]>("SELECT value FROM parameters WHERE scope='INSTANCE' AND instance='odim' AND `key`='feature_odim_usable_copy_enabled' AND sectorId IS NULL AND userId IS NULL"); return rows.length === 1 && rows[0].value === "true"; }
async function verifySource() { const r = await querySource("SELECT DATABASE() db,@@hostname host,VERSION() version"); safe(r[0]?.db === "crm_sgr" && r[0]?.host === "INPULSE" && r[0]?.version === "5.5.0-m2-community", "SOURCE_IDENTITY_MISMATCH"); sourceVerified = true; }
const byId = (rows: any[], id: unknown) => rows.find(r => Number(r.CODIGO) === Number(id)) || null;
async function copyRows(messages: any[], advance: number | null) {
 messages = messages.filter(message => String(message.TIPO).toLowerCase() !== "reaction");
 if (!messages.length && advance !== null) await db.execute("UPDATE odim_operational_copy_sync_state SET message_cursor=?,updated_at=UTC_TIMESTAMP(3) WHERE instance='odim' AND run_id=?", [advance, ODIM_COPY_RUN]);
 if (!messages.length) return;
 const contactIds = [...new Set(messages.flatMap(m => m.CODIGO_NUMERO == null ? [] : [m.CODIGO_NUMERO]))], chatIds = [...new Set(messages.flatMap(m => m.CODIGO_ATENDIMENTO == null ? [] : [m.CODIGO_ATENDIMENTO]))];
 const chats = chatIds.length ? await querySource("SELECT a.*,CAST(DATA_INICIO AS CHAR) DATA_INICIO,CAST(DATA_FIM AS CHAR) DATA_FIM,CAST(DATA_AGENDAMENTO AS CHAR) DATA_AGENDAMENTO FROM w_atendimentos a WHERE CODIGO IN (?)", [chatIds]) : [];
 for (const chat of chats) if (chat.CODIGO_NUMERO != null && !contactIds.includes(chat.CODIGO_NUMERO)) contactIds.push(chat.CODIGO_NUMERO);
 const contacts = contactIds.length ? await querySource("SELECT * FROM w_clientes_numeros WHERE CODIGO IN (?)", [contactIds]) : [];
 const files = await querySource("SELECT * FROM w_mensagens_arquivos WHERE CODIGO_MENSAGEM IN (?)", [messages.map(m => m.CODIGO)]);
 const refs = [...new Set(messages.flatMap(m => m.ID_REFERENCIA ? [m.ID_REFERENCIA] : []))], quotes = refs.length ? await querySource("SELECT CODIGO,ID FROM w_mensagens WHERE ID IN (?)", [refs]) : [];
 const emitted: { id: number; changed: boolean; chatId: number | null }[] = [];
 await db.beginTransaction();
 try {
  const writer = new OdimLiveCopyWriter(db, config), contactMap = new Map<number, number>(), chatMap = new Map<number, number>();
  for (const c of contacts) contactMap.set(Number(c.CODIGO), await writer.contact(c));
  for (const c of chats) chatMap.set(Number(c.CODIGO), await writer.chat(c, contactMap.get(Number(c.CODIGO_NUMERO)) || null));
  for (const m of messages) { const quote = quotes.find(q => q.ID === m.ID_REFERENCIA); emitted.push(await writer.message(m, byId(contacts, m.CODIGO_NUMERO), contactMap.get(Number(m.CODIGO_NUMERO)) || null, chatMap.get(Number(m.CODIGO_ATENDIMENTO)) || null, files.find(f => Number(f.CODIGO_MENSAGEM) === Number(m.CODIGO)) || null, quote ? Number(quote.CODIGO) : null)); }
  if (advance !== null) await db.execute("UPDATE odim_operational_copy_sync_state SET message_cursor=?,updated_at=UTC_TIMESTAMP(3) WHERE instance='odim' AND run_id=?", [advance, ODIM_COPY_RUN]);
  await db.commit();
 } catch (error) { await db.rollback(); throw error; }
 await emitChanges(emitted);
}
async function emitChanges(emitted: { id: number; changed: boolean; chatId: number | null }[]) {
 // Database journal remains the source of truth if an optional UI notification fails.
 for (const e of emitted.filter(e => e.changed && e.chatId !== null)) {
  try {
   const [rows] = await db.execute<any[]>("SELECT m.id,m.instance,m.waba_id wabaId,m.wwebjs_id wwebjsId,m.`from`,m.`to`,m.type,m.quoted_id quotedId,m.chat_id chatId,m.contact_id contactId,m.body,m.timestamp,m.sent_at sentAt,m.status,m.file_id fileId,m.file_name fileName,m.file_type fileType,m.user_id userId,m.client_id clientId FROM messages m WHERE m.id=? AND m.instance='odim'", [e.id]);
   if (rows[0]) {
    const snapshot = rows[0].wabaId && rows[0].clientId ? await odimReactionSnapshot(db, Number(rows[0].clientId), rows[0].wabaId) : null;
    await socket.emit(SocketEventType.WppMessage, `odim:chat:${e.chatId!}`, { message: { ...rows[0], ...(snapshot ? { reaction: snapshot.reaction, reactions: snapshot.reactions, reactionsUpdatedAt: snapshot.reactionsUpdatedAt } : {}) } });
    if (snapshot?.reactionsUpdatedAt) {
     const { chatId, ...data } = snapshot;
     await socket.emit(SocketEventType.WppMessageReaction, `odim:chat:${chatId}`, data);
    }
   }
  } catch { /* Normal session-change polling reconciles missed notifications. */ }
 }
}
async function emitReactionChanges(changes: OdimMirrorReactionChange[]) {
 for (const change of changes) {
  try {
   const snapshot = await odimReactionSnapshot(db, change.clientId, change.targetMessageId);
   if (snapshot) {
    const { chatId, ...data } = snapshot;
    await socket.emit(SocketEventType.WppMessageReaction, `odim:chat:${chatId}`, data);
   }
  } catch { /* The committed reaction remains available to normal history hydration. */ }
 }
}
async function tick() {
 if (busy || stopping) return; busy = true;
 try {
  const profile = readOdimAccessOnlyProfile(odimAccessOnlyProfilePath);
  if (profile.state !== "valid") { lastError = "COPY_PROFILE_INVALID"; return; }
  config.preserveCurrentOperations = !profile.enabled;
  if (!await featureEnabled()) { lastError = "COPY_DISABLED"; return; }
  await verifySource();
  const [state] = await db.execute<any[]>("SELECT message_cursor FROM odim_operational_copy_sync_state WHERE instance='odim' AND run_id=?", [ODIM_COPY_RUN]); safe(state.length === 1, "SYNC_STATE_REQUIRED");
  const delta = await querySource("SELECT m.*,CAST(DATA_HORA AS CHAR) DATA_HORA,CAST(old_data_Hora AS CHAR) old_data_Hora FROM w_mensagens m WHERE CODIGO>? ORDER BY CODIGO LIMIT 100", [Number(state[0].message_cursor)]);
  await copyRows(delta, delta.length ? Number(delta.at(-1).CODIGO) : null);
  if (++loops % 8 === 0) {
   const recent = await querySource("SELECT m.*,CAST(DATA_HORA AS CHAR) DATA_HORA,CAST(old_data_Hora AS CHAR) old_data_Hora FROM w_mensagens m WHERE CODIGO<=? ORDER BY CODIGO DESC LIMIT 50", [delta.length ? Number(delta.at(-1).CODIGO) : Number(state[0].message_cursor)]);
   await copyRows(recent, null);
  }
  const [pending] = await db.execute<any[]>("SELECT id,provider_id,kind,payload FROM odim_operational_copy_webhooks WHERE state='PENDING' AND received_at<UTC_TIMESTAMP(3)-INTERVAL 2 SECOND ORDER BY received_at LIMIT 20");
  if (pending.length) {
   const events = pending.map(event => ({ ...event, payload: typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload }));
   const sourceIds = [...new Set(events.map(event => odimMirrorSourceId(event.kind, event.payload, event.provider_id)).filter(Boolean))];
   const observed = sourceIds.length ? await querySource("SELECT m.*,CAST(DATA_HORA AS CHAR) DATA_HORA,CAST(old_data_Hora AS CHAR) old_data_Hora FROM w_mensagens m WHERE ID IN (?)", [sourceIds]) : [];
   await copyRows(observed, null);
   for (const event of events) {
    await processOdimMirrorWebhook(db, event, config.operationalClientId, observed.some(m => m.ID === event.provider_id), {
     message: change => emitChanges([change]), reaction: change => emitReactionChanges([change]),
    });
   }
  }
  lastError = null; lastSyncAt = new Date().toISOString();
  // Separate pool connection and bounded source client keep optional reconciliation off the copy path.
  void readReconciliation?.run();
 } catch (e) { sourceVerified = false; lastError = e instanceof Error && /^[A-Z_]{3,64}$/.test(e.message) ? e.message : "COPY_SYNC_RETRY_PENDING"; if ((e as any)?.fatal || ["PROTOCOL_CONNECTION_LOST", "ECONNRESET", "EPIPE"].includes((e as any)?.code)) process.emit("SIGTERM"); }
 finally { busy = false; }
}
async function main() {
 const key = keyConfig(), url = process.env["WHATSAPP_DATABASE_URL"]; safe(url, "DATABASE_CONFIG_REQUIRED"); db = await mysql.createConnection({ uri: url!, dateStrings: true, timezone: "Z" } as any); pool = mysql.createPool({ uri: url!, dateStrings: true, timezone: "Z", connectionLimit: 2 } as any);
 const [[pin]] = await db.query<any[]>("SELECT DATABASE() db,@@hostname host,@@server_uuid uuid,VERSION() version"); safe(pin.db === "inpulse-whatsapp" && pin.host === "srv733293" && pin.uuid === "fa36075c-fd89-11ef-b8d7-bc241123d405" && pin.version === "8.0.36-28", "TARGET_IDENTITY_MISMATCH");
 await db.query("SET time_zone='+00:00'");
 pool.on("connection", connection => { connection.query("SET time_zone='+00:00'"); });
 const readSource = new InstancesClient("http://127.0.0.1:8000"), readSocket = new SocketServerClient("http://127.0.0.1:8004");
 readSource.ax.defaults.timeout = 5_000; readSocket.ax.defaults.timeout = 3_000;
 readReconciliation = new OdimCopyReadReconciler(
  async (sql, values) => pool.execute({ sql, timeout: 5_000 }, values),
  (sql, values) => readSource.executeQuery<any[]>("odim", sql, values),
  change => readSocket.emit(SocketEventType.WppMessageStatus, `odim:chat:${change.chatId}`, { messageId: change.id, contactId: change.contactId, status: "READ" }),
 );
 const [[lock]] = await db.query<any[]>("SELECT GET_LOCK('odim-operational-live-copy-v1',0) held"); safe(lock.held === 1, "COPY_WORKER_ALREADY_RUNNING");
 const [[run]] = await db.execute<any[]>("SELECT status,config_json FROM instance_migration_runs WHERE id=? AND instance='odim'", [ODIM_COPY_RUN]); safe(run?.status === "COPY_VALIDATED", "INITIAL_COPY_REQUIRED"); config = typeof run.config_json === "string" ? JSON.parse(run.config_json) : run.config_json;
 const [configuredClients] = await db.execute<any[]>("SELECT id,waba_phone_id FROM clients WHERE instance='odim' AND type='WABA' AND waba_token IS NOT NULL AND LENGTH(waba_token)>0 AND waba_account_id IS NOT NULL AND waba_phone_id IS NOT NULL");
 const mappedClients = configuredClients.filter(c => config.clientIds[c.waba_phone_id] === c.id);
 safe(mappedClients.length === 1, "COPY_CONFIGURED_CHANNEL_REQUIRED");
 config.operationalClientId = mappedClients[0].id;
 const [[cursor]] = await db.execute<any[]>("SELECT MAX(source_id) sourceId FROM legacy_readonly_history_rows WHERE snapshot_id=? AND domain='w_mensagens'", [SNAP]);
 await db.execute("INSERT IGNORE INTO odim_operational_copy_sync_state(instance,run_id,message_cursor) VALUES('odim',?,?)", [ODIM_COPY_RUN, cursor.sourceId]);
 await verifySource();
 const server = createServer(createOdimCopyIngress(key, async events => {
  if (events.length) await pool.query("INSERT IGNORE INTO odim_operational_copy_webhooks(id,provider_id,kind,payload) VALUES ?", [events]);
 }, async () => {
  const [events] = await pool.query<any[]>("SELECT state,COUNT(*) n FROM odim_operational_copy_webhooks GROUP BY state");
  return { service: "odim-operational-copy", sourceVerified, lastError, lastSyncAt, events, providersEnabled: false, readReconciliation: readReconciliation?.health };
 }));
 server.requestTimeout = 10000; server.headersTimeout = 5000; server.listen(8125, "127.0.0.1", () => console.log(JSON.stringify({ service: "odim-operational-copy", listening: "loopback:8125", sourceVerified, providersEnabled: false })));
 const timer = setInterval(() => { void tick(); }, 2000); void tick();
 const stop = () => { stopping = true; clearInterval(timer); server.close(); const interval = setInterval(() => { if (!busy && !readReconciliation?.running) { clearInterval(interval); void Promise.all([db.end(), pool.end()]).then(() => process.exit(0)); } }, 100); };
 process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
main().catch(error => {
 const code = error instanceof Error && /^[A-Z_]{3,64}$/.test(error.message) ? error.message : "COPY_START_FAILED";
 console.error(JSON.stringify({ service: "odim-operational-copy", state: "START_FAILED", code, providersEnabled: false }));
 db?.destroy(); setTimeout(() => process.exit(1), 1500);
 void (pool?.end() || Promise.resolve()).finally(() => process.exit(1));
});
