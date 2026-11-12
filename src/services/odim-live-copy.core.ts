import { createHash } from "node:crypto";
export const ODIM_COPY_RUN = "f3c51f9d-9c0a-4654-a630-36f13ce7df40";
export const ODIM_COPY_ORIGIN = "172.22.139.22/crm_sgr/";
const prefix = "odim-live-copy-v1/";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const decode = (v: unknown) => { try { return decodeURI(String(v ?? "")); } catch { return String(v ?? ""); } };
export function liveCopyTime(r: any) {
 const n = Number(r.TIMESTAMP), ms = n > 10000000000 ? n : n * 1000;
 if (!Number.isSafeInteger(ms) || ms < 0 || ms > 4102444800000) throw Error("INVALID_SOURCE_UNIX");
 return { timestamp: String(ms), sent_at: new Date(ms).toISOString().slice(0, 19).replace("T", " ") };
}
export function liveCopyPriority(r: any) { const v = [r.URGENCIA_SUPERVISOR, r.URGENCIA_AGENDAMENTO, r.URGENCIA_OPERADOR].find(v => v != null && v !== ""); return ({ NORMAL: "NORMAL", MEDIA: "NORMAL", ALTA: "HIGH", MUITO_ALTA: "VERY_HIGH", URGENTE: "URGENCY" } as Record<string, string>)[v] || "NORMAL"; }
export function liveCopyStatus(v: string) { return ({ PLAYED: "READ", UNKNOWN_4: "UNKNOWN" } as Record<string, string>)[v] || (["PENDING", "SENT", "RECEIVED", "READ", "DOWNLOADED", "ERROR", "REVOKED", "UNKNOWN"].includes(v) ? v : "UNKNOWN"); }
/** Transaction-owned writer. No distribution, provider, queue or CRM write imports. */
export class OdimLiveCopyWriter {
 constructor(private readonly db: any, private readonly config: any) {}
 private async map(domain: string, source: any) { const [r] = await this.db.execute("SELECT target_id FROM instance_migration_maps WHERE instance='odim' AND entity=? AND source_id=? FOR UPDATE", [prefix + domain, ODIM_COPY_ORIGIN + source]); return r[0]?.target_id as number | undefined; }
 private async save(domain: string, row: any, target: number) {
  await this.db.execute("INSERT INTO instance_migration_maps(run_id,instance,entity,source_id,target_id,source_fingerprint,updated_at) VALUES(?,'odim',?,?,?,?,UTC_TIMESTAMP(3))", [ODIM_COPY_RUN, prefix + domain, ODIM_COPY_ORIGIN + row.CODIGO, target, hash(JSON.stringify(row))]);
 }
 private async version(domain: string, row: any) { const payload = JSON.stringify(row); await this.db.execute("INSERT IGNORE INTO odim_operational_copy_source_versions(instance,domain,source_id,payload_sha,payload) VALUES('odim',?,?,?,?)", [domain, row.CODIGO, hash(payload), payload]); }
 async contact(row: any) {
  const phone = digits(row.NUMERO), wa = digits(row.IDENTIFICADOR) || phone; let id = await this.map("contacts", row.CODIGO);
  if (!id) {
   const [same] = wa ? await this.db.execute("SELECT id,customer_id FROM contacts WHERE instance='odim' AND whatsapp_id=? LIMIT 2", [wa]) : [[]];
   if (same.length === 1 && (same[0].customer_id == null || row.CODIGO_CLIENTE == null || Number(same[0].customer_id) === Number(row.CODIGO_CLIENTE))) id = same[0].id;
   else if (same.length) throw Error("CONTACT_IDENTITY_CONFLICT");
   if (!id) {
    const [used] = await this.db.execute("SELECT id FROM contacts WHERE instance='odim' AND phone=? LIMIT 1", [phone]);
    const [insert] = await this.db.execute("INSERT INTO contacts(name,phone,whatsapp_id,customer_id,instance,is_deleted,is_blocked,is_only_admin,created_at,updated_at) VALUES(?,?,?,?,'odim',0,0,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [String(row.NOME || phone).slice(0, 191), used.length ? null : phone || null, wa || null, Number(row.CODIGO_CLIENTE) > 0 ? row.CODIGO_CLIENTE : null]); id = insert.insertId;
   }
   await this.save("contacts", row, id!);
  }
  const [owned] = await this.db.execute("SELECT id FROM contacts WHERE id=? AND instance='odim'", [id]); if (!owned.length) throw Error("CONTACT_OWNER_CONFLICT");
  await this.version("w_clientes_numeros", row); return id!;
 }
 async chat(row: any, contactId: number | null) {
  let id = await this.map("chats", row.CODIGO); const sectorId = await this.map("sectors", row.SETOR) || null;
  const values = [contactId, row.CODIGO_OPERADOR ?? null, row.RESULTADO ?? null, sectorId, String(row.ATIVO_RECEP).toUpperCase().includes("RECEP") ? "RECEPTIVE" : "ACTIVE", liveCopyPriority(row), Number(row.CONCLUIDO) ? 1 : 0, Number(row.CONCLUIDO) ? row.CODIGO_OPERADOR ?? null : null];
  if (!id) { const [insert] = await this.db.execute("INSERT INTO chats(instance,contact_id,user_id,result_id,sector_id,type,priority,is_finished,finished_by,is_schedule) VALUES('odim',?,?,?,?,?,?,?,?,0)", values); id = insert.insertId; await this.save("chats", row, id!); }
  else {
   const [old] = await this.db.execute("SELECT contact_id,user_id,result_id,sector_id,type,priority,is_finished,finished_by FROM chats WHERE id=? AND instance='odim' FOR UPDATE", [id]); if (!old.length) throw Error("CHAT_OWNER_CONFLICT");
   const columns = ["contact_id", "user_id", "result_id", "sector_id", "type", "priority", "is_finished", "finished_by"];
   if (!this.config.preserveCurrentOperations && columns.some((c, i) => String(old[0][c] ?? "") !== String(values[i] ?? ""))) await this.db.execute("UPDATE chats SET contact_id=?,user_id=?,result_id=?,sector_id=?,type=?,priority=?,is_finished=?,finished_by=? WHERE id=? AND instance='odim'", [...values, id]);
  }
  await this.version("w_atendimentos", row); return id!;
 }
 async message(row: any, contact: any | null, contactId: number | null, chatId: number | null, file: any | null, quoteSource: number | null) {
  let id = await this.map("messages", row.CODIGO), external = row.ID ? String(row.ID) : null;
  const field = external?.startsWith("wamid.") ? "waba_id" : "wwebjs_id";
  if (external) { const [registered] = await this.db.execute(`SELECT id FROM messages WHERE ${field}=? LIMIT 1`, [external]); if (registered.length && registered[0].id !== id) external = null; }
  const clientId = this.config.operationalClientId ?? Object.values(this.config.clientIds)[0]; if (!Number.isSafeInteger(clientId)) throw Error("COPY_CLIENT_REQUIRED");
  const address = contact ? digits(contact.IDENTIFICADOR) || digits(contact.NUMERO) : "legacy-unlinked", own = Number(row.FROM_ME) === 1, time = liveCopyTime(row);
  const quoteId = quoteSource === null ? null : await this.map("messages", quoteSource) || null;
  const fileName = file ? decode(file.NOME_ORIGINAL || file.NOME_ARQUIVO || "Anexo legado").split(/[\\/]/).pop()!.slice(0, 500) : null;
  const value: Record<string, any> = { wwebjs_id: field === "wwebjs_id" ? external : null, waba_id: field === "waba_id" ? external : null, from: own ? "me:odim-legacy-copy" : address, to: own ? address : "me:odim-legacy-copy", type: row.TIPO === "text" ? "chat" : row.TIPO || "chat", quoted_id: quoteId, chat_id: chatId, contact_id: contactId, body: decode(row.MENSAGEM), timestamp: time.timestamp, sent_at: time.sent_at, status: liveCopyStatus(row.STATUS), user_id: row.CODIGO_OPERADOR ?? null, client_id: clientId, file_name: fileName, file_type: file ? String(file.TIPO || "arquivo").slice(0, 191) : null };
  const cols = Object.keys(value);
  let changed = false;
  if (!id) { const [insert] = await this.db.query("INSERT INTO messages(instance," + cols.map(c => "`" + c + "`").join(",") + ") VALUES('odim'," + cols.map(() => "?").join(",") + ")", Object.values(value)); id = insert.insertId; await this.save("messages", row, id!); changed = true; }
  else {
   const [old] = await this.db.execute("SELECT * FROM messages WHERE id=? AND instance='odim' FOR UPDATE", [id]); if (!old.length) throw Error("MESSAGE_OWNER_CONFLICT");
   // Preserve already available files and the IDs of reconciled pre-existing records.
   value["waba_id"] = old[0].waba_id || value["waba_id"]; value["wwebjs_id"] = old[0].wwebjs_id || value["wwebjs_id"];
   if (!file || old[0].file_id != null) { value["file_name"] = old[0].file_name; value["file_type"] = old[0].file_type; }
   if (!quoteId) value["quoted_id"] = old[0].quoted_id;
   // A copied inbound receipt already read locally remains read in both migration modes.
   if (!own && old[0].status === "READ" && value["status"] !== "REVOKED") value["status"] = "READ";
   if (this.config.preserveCurrentOperations) {
    for (const c of ["body", "chat_id", "contact_id", "user_id", "client_id", "quoted_id"]) value[c] = old[0][c];
    const rank: Record<string,number> = { PENDING:0,UNKNOWN:0,ERROR:0,SENT:1,RECEIVED:2,READ:3 };
    if ((rank[old[0].status] ?? 0) > (rank[value["status"]] ?? 0)) value["status"] = old[0].status;
   }
   if (cols.some(c => String(old[0][c] ?? "") !== String(value[c] ?? ""))) { await this.db.query("UPDATE messages SET " + cols.map(c => "`" + c + "`=?").join(",") + " WHERE id=? AND instance='odim'", [...Object.values(value), id]); changed = true; }
  }
  await this.version("w_mensagens", row); if (file) await this.version("w_mensagens_arquivos", file);
  return { id: id!, changed, chatId };
 }
}
